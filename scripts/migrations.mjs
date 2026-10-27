// Config migrations: what /update-workflow does to a project's own config files when a plugin
// version changes their format. Each runs once, on a project whose stamp is older than its
// version, and returns the paths it changed (they are staged with the rest of the update).
//
//   { version: "0.3.0", describe: "what changes, in one line", run(dir) { …; return [paths]; } }
//
// None yet: 0.2.0 changed no config format.
export const MIGRATIONS = [];
