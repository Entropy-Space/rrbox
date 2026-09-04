use jni::{EnvUnowned, errors::ThrowRuntimeExAndDefault, objects::JObject};

// Called by the Application before Tauri starts any native HTTP clients.
// The verifier keeps global references to the application context and loader,
// not an Activity that can be destroyed during rotation or backgrounding.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_tokn_1ai_rrbox_RrboxApplication_initializeTls<'caller>(
  mut env: EnvUnowned<'caller>,
  application: JObject<'caller>,
) {
  env
    .with_env(|env| rustls_platform_verifier::android::init_with_env(env, application))
    .resolve::<ThrowRuntimeExAndDefault>();
}
