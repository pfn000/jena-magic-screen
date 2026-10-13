user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
// Keep the persistent ~/.ffprofile cookies across restarts; mama signs in herself via takeover.
user_pref("privacy.sanitize.sanitizeOnShutdown", false);
user_pref("network.cookie.lifetimePolicy", 0);
// Links that ask for a new window/tab (target=_blank, window.open) load in the CURRENT tab: Jena never piles up tabs.
// Only mama's own words ("open X in a new tab") make her press Ctrl+T, and she keeps at most 2 extra tabs.
user_pref("browser.link.open_newwindow", 1);
user_pref("browser.link.open_newwindow.restriction", 0);
user_pref("browser.tabs.loadInBackground", false);
