//! Project Tokn-owned model capabilities without exposing account credentials.
use std::collections::BTreeMap;

use serde_json::{Value, json};
use tokn_accounts::registry::Registry;

use super::ToknSettingsSnapshot;

pub fn models(snapshot: &ToknSettingsSnapshot) -> Value {
  let registry = Registry::builtin();
  let configured = snapshot
    .accounts
    .iter()
    .filter(|account| account.enabled)
    .map(|account| (account.provider_id.clone(), ()))
    .collect::<BTreeMap<_, _>>();
  let catalogues = configured
    .keys()
    .map(|id| (id.as_str(), tokn_catalogue::default_models_for(id)))
    .collect::<BTreeMap<_, _>>();
  let data: Vec<_> = snapshot
    .model_ids
    .iter()
    .filter_map(|selector| {
      let Some((provider_id, model_id)) = selector.split_once('/') else {
        // Advanced routing aliases do not have a single upstream capability set.
        return Some(json!({"id": selector, "object": "model"}));
      };
      let Some(catalogue) = catalogues.get(provider_id) else {
        // Do not advertise known providers without an enabled configured account.
        return if registry.resolve(provider_id).is_some() {
          None
        } else {
          Some(json!({"id": selector, "object": "model"}))
        };
      };
      let mut metadata = catalogue
        .iter()
        .find(|model| model.id == model_id)
        .and_then(|model| serde_json::to_value(model).ok())
        .unwrap_or_else(|| json!({}));
      metadata["upstream_provider_id"] = json!(provider_id);
      Some(json!({"id": selector, "object": "model", "x_tokn_router": metadata}))
    })
    .collect();
  json!({"object": "list", "data": data})
}
