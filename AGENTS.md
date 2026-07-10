# Project Rules

## Scope

- This repository contains one standalone Tampermonkey userscript for the OUCN learning platform.
- The product is Chinese-facing; user-visible copy and README content may be Chinese. Keep JavaScript identifiers and comments in English unless Chinese text is required for the platform UI.
- Do not store credentials, tokens, cookies, or other secrets in the repository or project memory.

## Structure

- `国开学习平台-自动刷课助手.user.js`: distributable userscript and the only runtime artifact.
- `tests/autoplayer-regression.test.js`: Node built-in test regression harness for the userscript.
- `README.md`: installation, behavior, and release-facing documentation.
- `log.txt`: local diagnostic log fixture supplied for bug investigation; never publish personal data from it.

## Verification

Run these checks before delivery or a release:

```powershell
node --check .\国开学习平台-自动刷课助手.user.js
node --test .\tests\autoplayer-regression.test.js
git diff --check
```

For browser validation, use the already authenticated Edge session only when the user grants permission. Do not automate login, CAPTCHA, or credential entry.

## Release Rules

- Keep the userscript metadata version, update-check version, README badge, and README history aligned.
- The update checker must compare the latest published GitHub Release tag, not a branch file.
- Create a GitHub tag and published Release only after local checks pass and the release assets are the intended distributables.
