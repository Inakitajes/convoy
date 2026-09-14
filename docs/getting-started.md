# Getting started

[Documentation](README.md) · [Convoy](../README.md)

Install Convoy, check the requirements, and update your binary.

- [Requirements](#requirements)
- [Installation](#installation)
- [Version and updates](#version-and-updates)

## Requirements

### Release binary

- macOS (Apple Silicon or Intel), or Linux (ARM64 or x64)
- `opencode` installed and authenticated (`opencode auth login`)
- `git`

Bun is included in the release binary; it is **not** a user requirement. See [provider setup](models.md#authentication-and-providers) to authenticate the models used by your pipeline.

### Development

- Bun 1.3+ (the release build pins 1.3.14)
- `opencode` installed and authenticated (`opencode auth login`)
- `git`

## Installation

### Install script (recommended)

```bash
curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | sh
```

The script detects your platform, downloads the matching release binary, **verifies it against the release's `SHA256SUMS`**, installs it into `~/.local/bin`, and creates `~/.convoy/config.yaml` if it does not already exist. Nothing is installed unless the checksum matches and the downloaded binary reports its own version, and the final move is atomic, so a failed install never leaves a partial binary behind.

Options are accepted as environment variables, or as flags after `sh -s --`:

| Variable | Flag | Default |
| --- | --- | --- |
| `CONVOY_VERSION` | `--version <tag>` | `latest` |
| `CONVOY_INSTALL_DIR` | `--dir <path>` | `$HOME/.local/bin` |
| `CONVOY_NO_INIT` | `--no-init` | unset |

```bash
# Pin an exact release
curl -fsSL https://github.com/Inakitajes/convoy/releases/download/v0.1.0/install.sh | sh

# Install somewhere else
curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | CONVOY_INSTALL_DIR="$HOME/bin" sh

# Skip creating the default configuration
curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | sh -s -- --no-init
```

The script is [`install.sh`](../install.sh) in this repository, published as an asset of every release and listed in that release's `SHA256SUMS`, so the URL above always resolves to the script tested against those exact binaries. To read it before running it, drop the pipe:

```bash
curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh -o install.sh
less install.sh && sh install.sh
```

### Manual download

GitHub Releases are the distribution source and preserve every published version. To skip the script, download the binary for your platform into `~/.local/bin`, then make it executable:

```bash
mkdir -p ~/.local/bin

# macOS on Apple Silicon
curl -fL https://github.com/Inakitajes/convoy/releases/latest/download/convoy-darwin-arm64 -o ~/.local/bin/convoy

# macOS on Intel
# curl -fL https://github.com/Inakitajes/convoy/releases/latest/download/convoy-darwin-x64 -o ~/.local/bin/convoy

# Linux on ARM64
# curl -fL https://github.com/Inakitajes/convoy/releases/latest/download/convoy-linux-arm64 -o ~/.local/bin/convoy

# Linux on x64
# curl -fL https://github.com/Inakitajes/convoy/releases/latest/download/convoy-linux-x64 -o ~/.local/bin/convoy

chmod 755 ~/.local/bin/convoy
convoy --version
```

This path verifies nothing on its own; every release publishes a `SHA256SUMS` if you want to check the download yourself. Make sure `~/.local/bin` is on your `PATH`. To install an exact version, replace `/releases/latest/download/` with `/releases/download/v0.1.0/` (or another tag). The [Releases page](https://github.com/Inakitajes/convoy/releases) lists all available versions.

### Development install

Use the source flow only when developing Convoy itself:

```bash
git clone https://github.com/Inakitajes/convoy.git
cd convoy
bun install
make install
```

This builds a local binary in `~/.local/bin/convoy` and creates `~/.convoy/config.yaml` with Convoy's default configuration if it does not already exist.

## Version and updates

```bash
# Show the release version, build commit, and target platform
convoy --version

# Check the latest stable GitHub Release without changing files
convoy update --check

# Download, verify (GitHub SHA-256 digest + SHA256SUMS), and atomically install a newer release
convoy update
```

Updates are explicit: Convoy does not make network calls when it starts. `convoy update` only changes official standalone release binaries; it never modifies a source checkout, `~/.convoy`, project configuration, runs, or worktrees.

Release candidates use prerelease tags such as `v0.2.0-rc.1`. They are published as GitHub prereleases and never replace the stable `latest` release; install one explicitly from its release tag when testing it.

---

[Back to documentation](README.md)
