# KrutrimConnect

Connect Codex and OpenCode to Krutrim Cloud models using your existing API key.

## Install

**The first stable release has not yet been published.** The installer below
becomes available once its release archives are published.

```sh
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.sh \
  -o /tmp/krutrimconnect-install.sh && sh /tmp/krutrimconnect-install.sh
```

Supports macOS Apple Silicon, macOS Intel and Linux x64 (glibc). No Node.js or npm
installation is required. Install Codex or OpenCode separately.
If the command is not found after installation, follow the installer's PATH instructions.

## Sign in and choose a model

```sh
krutrimconnect login
krutrimconnect models list
```

Enter your Krutrim Cloud API key when prompted. [Get or manage an API key](https://docs.cloud.olakrutrim.com/basics/key-management-system/model-api-keys).

## Connect your coding tool

Replace `MODEL_ID` with an available model from the list.

```sh
# Codex
krutrimconnect codex on --model MODEL_ID

# OpenCode
krutrimconnect opencode on --model MODEL_ID
```

Restart the coding tool after connecting. Model compatibility checks may incur
inference charges. To restore the previous configuration:

```sh
krutrimconnect codex off
krutrimconnect opencode off
```

## Check, upgrade or uninstall

```sh
krutrimconnect status
krutrimconnect doctor
krutrimconnect upgrade --check
krutrimconnect upgrade
krutrimconnect uninstall
```

See the [user guide](docs/user-guide.md) for setup help, credentials and troubleshooting.

## Terms and licence

Source code: [Apache 2.0](LICENSE), with [notices](NOTICE) and [licence scope](docs/legal/LICENSE_SCOPE.md).
Krutrim Cloud use is governed by its [Terms & Conditions](https://www.olakrutrim.com/terms-and-conditions)
and [Privacy Policy](https://www.olakrutrim.com/privacy-policy). Review and test AI-generated output before use.
See [user notices](docs/legal/USER_NOTICES.md) and [security guidance](SECURITY.md).
