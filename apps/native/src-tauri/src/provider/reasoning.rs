use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};

/// Provider-defined choices, in provider order. IDs are not a global enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningEffortOption {
  pub id: String,
  pub display_name: String,
  #[serde(
    default,
    deserialize_with = "deserialize_description",
    skip_serializing_if = "Option::is_none"
  )]
  pub description: Option<String>,
}

fn deserialize_description<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
  D: Deserializer<'de>,
{
  String::deserialize(deserializer).map(Some)
}

pub fn deserialize_options<'de, D>(deserializer: D) -> Result<Vec<ReasoningEffortOption>, D::Error>
where
  D: Deserializer<'de>,
{
  #[derive(Deserialize)]
  #[serde(untagged)]
  enum Input {
    Legacy(String),
    Option(ReasoningEffortOption),
  }

  let options: Vec<_> = Vec::<Input>::deserialize(deserializer)?
    .into_iter()
    .map(|input| match input {
      Input::Option(option) => option,
      Input::Legacy(id) => {
        let mut characters = id.chars();
        let display_name = characters
          .next()
          .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
          .unwrap_or_default();
        ReasoningEffortOption {
          id,
          display_name,
          description: None,
        }
      }
    })
    .collect();
  validate_options(&options).map_err(serde::de::Error::custom)?;
  Ok(options)
}

pub fn validate_options(options: &[ReasoningEffortOption]) -> Result<(), String> {
  if options.len() > 64 {
    return Err("reasoning_efforts must contain at most 64 options.".into());
  }
  let mut ids = HashSet::new();
  for option in options {
    validate_text(&option.id, "reasoning effort ID", 128)?;
    if option.id == "default" {
      return Err("default is reserved for automatic reasoning effort.".into());
    }
    if !ids.insert(&option.id) {
      return Err("Duplicate reasoning effort ID.".into());
    }
    validate_text(&option.display_name, "reasoning effort display_name", 256)?;
    if let Some(description) = &option.description {
      validate_text(description, "reasoning effort description", 1024)?;
    }
  }
  Ok(())
}

fn validate_text(value: &str, field: &str, max_bytes: usize) -> Result<(), String> {
  if value.is_empty()
    || value != value.trim()
    || value.len() > max_bytes
    || value.chars().any(char::is_control)
  {
    return Err(format!(
      "Invalid {field}: expected non-empty text of at most {max_bytes} UTF-8 bytes without surrounding whitespace or control characters."
    ));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[derive(Debug, Serialize, Deserialize)]
  struct Model {
    #[serde(deserialize_with = "deserialize_options")]
    reasoning_efforts: Vec<ReasoningEffortOption>,
  }

  #[test]
  fn roundtrips_opaque_ids_and_provider_labels_and_migrates_legacy_strings() {
    let input = json!({"reasoning_efforts": [
      {"id": "ultra", "display_name": "Think deeply", "description": "Provider-defined budget."},
      "vendor:adaptive-v2"
    ]});
    let model: Model = serde_json::from_value(input).unwrap();
    let output = serde_json::to_value(&model).unwrap();
    assert_eq!(output["reasoning_efforts"][0]["id"], "ultra");
    assert_eq!(
      output["reasoning_efforts"][0]["display_name"],
      "Think deeply"
    );
    assert_eq!(
      output["reasoning_efforts"][1]["display_name"],
      "Vendor:adaptive-v2"
    );
    let reloaded: Model = serde_json::from_value(output).unwrap();
    assert_eq!(reloaded.reasoning_efforts, model.reasoning_efforts);
  }

  #[test]
  fn rejects_invalid_structures_not_unfamiliar_vocabulary() {
    for options in [
      json!([""]),
      json!(["default"]),
      json!([" ultra"]),
      json!(["ultra\n"]),
      json!(["a".repeat(129)]),
      json!(["思".repeat(43)]),
      json!(["ultra", "ultra"]),
      json!([{"id": "ultra"}]),
      json!([{"id": "ultra", "display_name": ""}]),
      json!([{"id": "ultra", "display_name": "Ultra", "description": 42}]),
      json!([{"id": "ultra", "display_name": "Ultra", "description": null}]),
    ] {
      assert!(serde_json::from_value::<Model>(json!({"reasoning_efforts": options})).is_err());
    }
  }
}
