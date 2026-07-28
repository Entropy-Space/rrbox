use rustpython::{
    InterpreterBuilder, InterpreterBuilderExt,
    vm::{
        TryFromObject,
        builtins::{PyBaseExceptionRef, PyStrRef},
        signal::{UserSignalReceiver, UserSignalSender, user_signal_channel},
    },
};
use serde::{Deserialize, Serialize};

const CAPTURE_SETUP: &str = r#"
class __ResearchBoxOutput:
  def __init__(self, limit):
    self.parts = []
    self.remaining = limit
    self.truncated = False

  def write(self, value):
    value = str(value)
    encoded = value.encode("utf-8")
    if self.remaining <= 0:
      if encoded:
        self.truncated = True
      return len(value)
    if len(encoded) > self.remaining:
      encoded = encoded[:self.remaining]
      value = encoded.decode("utf-8", "ignore")
      self.truncated = True
    self.parts.append(value)
    self.remaining -= len(value.encode("utf-8"))
    return len(value)

  def flush(self):
    pass

  def getvalue(self):
    return "".join(self.parts)

  def was_truncated(self):
    return self.truncated

import sys
__researchbox_stdout = __ResearchBoxOutput(__researchbox_stream_limit)
__researchbox_stderr = __ResearchBoxOutput(__researchbox_stream_limit)
sys.stdout = __researchbox_stdout
sys.stderr = __researchbox_stderr
"#;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PythonExecutionResult {
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
    pub output_truncated: bool,
}

#[derive(Clone, Debug)]
pub struct PythonCancellationHandle(UserSignalSender);

impl PythonCancellationHandle {
    pub fn cancel(&self) {
        let _ = self.0.send(Box::new(|vm| {
            Err(vm.new_exception_msg(
                vm.ctx.exceptions.keyboard_interrupt.to_owned(),
                "Python execution cancelled.".into(),
            ))
        }));
    }
}

pub fn execute_python(
    code: &str,
    max_output_bytes: usize,
) -> Result<PythonExecutionResult, String> {
    execute_python_with_signal(code, max_output_bytes, None)
}

pub fn execute_python_with_cancellation(
    code: &str,
    max_output_bytes: usize,
    register_cancellation: impl FnOnce(PythonCancellationHandle),
) -> Result<PythonExecutionResult, String> {
    let (sender, receiver) = user_signal_channel();
    register_cancellation(PythonCancellationHandle(sender));
    execute_python_with_signal(code, max_output_bytes, Some(receiver))
}

fn execute_python_with_signal(
    code: &str,
    max_output_bytes: usize,
    signal_receiver: Option<UserSignalReceiver>,
) -> Result<PythonExecutionResult, String> {
    if max_output_bytes == 0 {
        return Err("max_output_bytes must be greater than zero.".to_owned());
    }

    let mut settings = rustpython::vm::Settings::default();
    settings.install_signal_handlers = false;
    settings.import_site = false;
    settings.user_site_directory = false;
    settings.write_bytecode = false;

    let mut receiver = signal_receiver;
    let interpreter = InterpreterBuilder::new()
        .settings(settings)
        .init_stdlib()
        .init_hook(move |vm| {
            if let Some(receiver) = receiver.take() {
                vm.set_user_signal_channel(receiver);
            }
        })
        .build();

    interpreter.enter(|vm| {
        let scope = vm.new_scope_with_builtins();
        let stream_limit = (max_output_bytes / 2).max(1);
        scope
            .globals
            .set_item(
                "__researchbox_stream_limit",
                vm.ctx.new_int(stream_limit).into(),
                vm,
            )
            .map_err(|error| render_exception(vm, error))?;
        vm.run_string(
            scope.clone(),
            CAPTURE_SETUP,
            "<researchbox-capture>".to_owned(),
        )
        .map_err(|error| render_exception(vm, error))?;

        let stdout_capture = scope
            .globals
            .get_item("__researchbox_stdout", vm)
            .map_err(|error| render_exception(vm, error))?;
        let stderr_capture = scope
            .globals
            .get_item("__researchbox_stderr", vm)
            .map_err(|error| render_exception(vm, error))?;

        let execution_error = vm
            .run_string(scope, code, "<agent-python>".to_owned())
            .err()
            .map(|error| render_exception(vm, error));
        let stdout = capture_string(vm, &stdout_capture, "getvalue")?;
        let stderr = capture_string(vm, &stderr_capture, "getvalue")?;
        let output_truncated = capture_bool(vm, &stdout_capture, "was_truncated")?
            || capture_bool(vm, &stderr_capture, "was_truncated")?;

        let mut result = PythonExecutionResult {
            stdout,
            stderr,
            error: execution_error,
            output_truncated,
        };
        enforce_combined_output_limit(&mut result, max_output_bytes);
        Ok(result)
    })
}

fn capture_string(
    vm: &rustpython::vm::VirtualMachine,
    capture: &rustpython::vm::PyObjectRef,
    method: &str,
) -> Result<String, String> {
    let value = vm
        .call_method(capture, method, ())
        .map_err(|error| render_exception(vm, error))?;
    let value: PyStrRef = value
        .try_into_value(vm)
        .map_err(|error| render_exception(vm, error))?;
    Ok(value.as_wtf8().to_string_lossy().into_owned())
}

fn capture_bool(
    vm: &rustpython::vm::VirtualMachine,
    capture: &rustpython::vm::PyObjectRef,
    method: &str,
) -> Result<bool, String> {
    let value = vm
        .call_method(capture, method, ())
        .map_err(|error| render_exception(vm, error))?;
    bool::try_from_object(vm, value).map_err(|error| render_exception(vm, error))
}

fn render_exception(vm: &rustpython::vm::VirtualMachine, error: PyBaseExceptionRef) -> String {
    let mut rendered = String::new();
    if vm.write_exception(&mut rendered, &error).is_err() {
        return "Python execution failed and its exception could not be rendered.".to_owned();
    }
    rendered
}

fn enforce_combined_output_limit(result: &mut PythonExecutionResult, max_output_bytes: usize) {
    let mut remaining = max_output_bytes;
    result.stdout = take_utf8_prefix(&result.stdout, &mut remaining);
    result.stderr = take_utf8_prefix(&result.stderr, &mut remaining);
    if let Some(error) = &result.error {
        let truncated = take_utf8_prefix(error, &mut remaining);
        if truncated.len() < error.len() {
            result.output_truncated = true;
        }
        result.error = Some(truncated);
    }
    if result.stdout.len() + result.stderr.len() > max_output_bytes {
        result.output_truncated = true;
    }
}

fn take_utf8_prefix(value: &str, remaining: &mut usize) -> String {
    if value.len() <= *remaining {
        *remaining -= value.len();
        return value.to_owned();
    }
    let mut end = *remaining;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    *remaining = 0;
    value[..end].to_owned()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::execute_python;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn execute_python_wasm(code: &str, max_output_bytes: usize) -> Result<JsValue, JsValue> {
        let result =
            execute_python(code, max_output_bytes).map_err(|error| JsValue::from_str(&error))?;
        serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::execute_python;

    #[test]
    fn executes_stateless_python_and_captures_output() {
        let first = execute_python("value = 41\nprint(value + 1)", 4096).unwrap();
        assert_eq!(first.stdout, "42\n");
        assert_eq!(first.stderr, "");
        assert_eq!(first.error, None);
        assert!(!first.output_truncated);

        let second = execute_python("print('value' in globals())", 4096).unwrap();
        assert_eq!(second.stdout, "False\n");
    }

    #[test]
    fn returns_python_exceptions_with_prior_output() {
        let result = execute_python("print('before')\nraise ValueError('bad')", 4096).unwrap();
        assert_eq!(result.stdout, "before\n");
        assert!(result.error.as_deref().unwrap().contains("ValueError: bad"));
    }

    #[test]
    fn truncates_large_output() {
        let result = execute_python("print('x' * 1000)", 64).unwrap();
        assert!(result.stdout.len() <= 32);
        assert!(result.output_truncated);
    }

    #[test]
    fn excludes_host_filesystem_and_network_modules() {
        let filesystem = execute_python("open('/tmp/researchbox-python-test', 'w')", 4096).unwrap();
        assert!(filesystem.error.is_some());

        let network = execute_python("import socket", 4096).unwrap();
        assert!(network.error.is_some());
    }
}
