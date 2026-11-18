# Herdr Serve

Use your running Herdr session from a phone, tablet, or desktop browser. This companion service, also installable as a Herdr plugin, streams the **actual Herdr terminal interface** through an authenticated WebSocket. It runs alongside Herdr, without patching it or installing a browser extension.

- Interactive terminal with ANSI colors, mouse input, and live resizing.
- Phone controls for Herdr's prefix key, Ctrl, Esc, Tab, arrows, and Enter.
- A text composer for mobile keyboards and multiline paste.
- Light/dark theme buttons on the login page and terminal toolbar. The browser remembers your selection; before you choose, it follows the system appearance. Terminal defaults, ANSI palette, cursor and selection follow the theme; applications that explicitly draw their own RGB colors retain those colors.
- Automatic reconnect after network interruptions.
- Each browser attaches its own client; closing the browser leaves Herdr's agents running.
- Token sign-in, expiring HttpOnly cookies, strict origin checks, login throttling, and bounded terminal connections.

## Herdr plugin

The plugin adds start/stop/status actions and a terminal control panel. It launches the same web service as standalone mode. Requires Herdr 0.9.1+, Node.js 22+, and npm on the PATH used by Herdr; Linux and macOS are supported.

Install from GitHub after the public repository is available:

```sh
herdr plugin install ThetaField/herdr-serve
herdr plugin action invoke herdr.serve.panel
```

For local development:

```sh
npm ci
npm run build
herdr plugin link .
herdr plugin action invoke herdr.serve.panel
```

The panel first offers **1: Cloudflare Tunnel**, **2: Tailscale Funnel**, and **3: Service controls**, alongside the current URL, target session, configuration/log paths and configured public provider. Selecting a provider only opens its submenu; it does not enable or switch a tunnel. Each provider has **s: Deploy / Setup**, **e: Enable**, **d: Disable**, **r: Refresh status**, **b: Back**, and **q: Close panel**. Setup returns to the same provider submenu when finished. Service controls contain **s: Start**, **x: Stop**, and **r: Refresh**. Stopping the service also disables its managed tunnel. Closing the panel leaves the web service running. CLI actions also work:

```sh
herdr plugin action invoke herdr.serve.start
herdr plugin action invoke herdr.serve.status
herdr plugin action invoke herdr.serve.stop
herdr plugin log list --plugin herdr.serve
```

Actions launch asynchronously; their CLI response means the action was launched. Check the panel or plugin logs for the final result. Web service output is in `serve.log` under the plugin state directory.

Before starting, edit `server.env` inside the directory printed by:

```sh
herdr plugin config-dir herdr.serve
```

The first action creates this file, or copies an existing `~/.config/herdr-serve/server.env` once. It never overwrites an existing plugin configuration. Set `HERDR_SERVE_ORIGIN` to the browser address you already use. This file uses dotenv syntax, with no shell commands, variable expansion, or `~` expansion; use absolute paths. It accepts the settings in the configuration table below. Set `HERDR_SERVE_SESSION` explicitly for named sessions; otherwise it attaches to the default session, independent of the pane from which you invoke the action.

Existing token and remembered-device files under `~/.config/herdr-serve/` are reused by default. Credentials supplied only through environment variables to your previous standalone process must be explicitly configured for the plugin. Use stop/start to apply changes. All Herdr sessions share this plugin's single managed service.

**Switching from standalone/systemd:** stop your existing web bridge using its original terminal or service manager before starting the plugin on the same port. A port collision is reported, never resolved by killing another process. The plugin manages only the service reached through its private local management socket; it does not stop Herdr sessions or agents. Do not run standalone and plugin instances with the same remembered-device file simultaneously.

The plugin has no automatic startup hook: linking, enabling, or opening Herdr never silently publishes a server. It does not provide crash restart or boot-time startup. Continue using systemd when those are required; in that case use the standalone deployment workflow rather than plugin start/stop. Stop the managed service before unlinking, uninstalling, moving, or upgrading its checkout; removing a manifest does not stop a detached process.

After publishing this repository on GitHub, users can install with `herdr plugin install OWNER/REPO`. The manifest runs `npm ci` and `npm run build` on GitHub installs. Local `plugin link` does not run those steps. This checkout has not been published automatically.

For troubleshooting outside Herdr, the manager also supports `npm run plugin -- status` (or `start`, `stop`, `ui`). Set `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR` to the same directories used by Herdr to manage that instance; without these variables the manager uses separate fallback directories. A crashed management action can leave an empty `operation.lock` directory. Verify that no action is still running before removing that directory and retrying. The lock prevents concurrent actions from launching duplicate servers.

## Guided Tailscale setup inside Herdr

```sh
herdr plugin action invoke herdr.serve.setup
```

Or select **2: Tailscale Funnel → s: Deploy / Setup** in the plugin panel. The wizard checks the Tailscale CLI and login state, then offers:

- `i`: on Linux, download the complete installer from `https://tailscale.com/install.sh` to a private temporary file and run it. The official installer detects the distribution and may request sudo. Existing installations are left in place. On macOS, the wizard points to the official app download instead.
- `s`: start `tailscaled` and enable it at boot on systemd Linux.
- `l`: run login; open the printed URL in your browser.
- `o`: allow the current OS user to manage Tailscale using its operator setting on Linux.
- `f`: enable the plugin's public Funnel (token login stays required).
- `r`: refresh checks; `q`: close the wizard.

Each operation runs only when selected. Password prompts go directly to the interactive terminal, not to an action's captured output. The installer requires a terminal, downloads over HTTPS before execution, and deletes its temporary file afterward. The wizard does not supply passwords or complete browser authentication for you. Failed or cancelled steps show an error so you can retry. No installation or privilege changes occur merely by linking the plugin or opening the wizard.

## One-action public access with Tailscale Funnel

The plugin can publish its managed web service through Tailscale Funnel, synchronize the HTTPS origin automatically, and restore your normal settings when disabled. It keeps token authentication enabled. **Funnel is a public endpoint, not a Tailscale user whitelist**: anyone can reach the sign-in page; a valid Herdr Serve credential is required to use the terminal.

Prerequisites: install a recent Tailscale CLI (the Serve/Funnel syntax from 1.52+), run the Tailscale daemon, log in with `tailscale up`, and enable the required MagicDNS/HTTPS and Funnel permission for this node in your tailnet. The OS user running Herdr must be allowed to configure Tailscale. Background actions do not install Tailscale or run sudo. The interactive setup wizard below can run installation and sudo commands you select; browser sign-in and tailnet policy approval remain yours to complete. If the initial authorization needs a browser, follow the Tailscale URL in the action error/log and retry. See the [Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel) and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

```sh
# Start/reconfigure the plugin-managed bridge and publish it:
herdr plugin action invoke herdr.serve.funnel-on
# Inspect the actual route:
herdr plugin action invoke herdr.serve.funnel-status
# Remove the public route and return to normal local/proxy configuration:
herdr plugin action invoke herdr.serve.funnel-off
```

Alternatively open the plugin panel, select **2: Tailscale Funnel**, then **e: Enable** or **d: Disable**. The panel displays the HTTPS URL. As with other actions, inspect the panel or `herdr plugin log list --plugin herdr.serve` for the result. The access token stays the same; the first visit to the new hostname requires sign-in.

The default public port is 443. If another Tailscale Serve or Funnel already uses that port, the plugin refuses to overwrite it. Add `HERDR_SERVE_FUNNEL_PORT=8443` or `10000` to the plugin's `server.env` to choose an alternative. Stop an existing Funnel before changing its port, local backend port, or Tailscale hostname.

While enabled, the plugin forces the backend onto `127.0.0.1` and uses the node's HTTPS hostname as its origin. It stores an override in the private plugin state directory (`funnel.json`); your `server.env` remains unchanged. The managed bridge may restart, temporarily disconnecting browsers, while Herdr agents remain running. An existing standalone/systemd bridge is not adopted: stop it before using this feature on the same port.

Normal plugin **Stop** removes the owned Funnel route before stopping the bridge. **Funnel off** removes the route and restarts a running bridge with its original configuration. Neither command uses `tailscale funnel reset`. If another tool changes the route or adds handlers on the same listener, the plugin refuses to delete that listener; inspect `tailscale funnel status` to resolve the conflict. Avoid editing the same listener concurrently through other tools.

Funnel uses Tailscale's background mode and therefore can survive a machine reboot or an unexpected bridge crash. A stopped/crashed bridge will be unavailable, but the forwarding rule can remain. Disable Funnel through the plugin before uninstalling or repurposing the local port. Saved ownership lets a later plugin invocation inspect or remove the rule. The plugin does not automatically start the bridge on boot. If an interrupted action leaves a management lock, follow the lock recovery instructions above.

The integration is tested with a simulated Tailscale CLI/configuration and a real local bridge, including Secure cookies, origin changes, rollback, and collision protection. Public connectivity still needs verification on a host with Tailscale installed and authorized.

## Cloudflare Tunnel (fixed hostname, remotely managed)

Cloudflare is an alternative to Tailscale Funnel. The plugin supports **remotely managed named tunnels created through automatic setup or the Cloudflare dashboard**, using `cloudflared` 2025.4.0+ and a token file. Temporary Quick Tunnels (`trycloudflare.com`) and locally managed credential-JSON tunnels are not supported by this integration.

Open the plugin panel (`herdr plugin action invoke herdr.serve.panel`) and select **1: Cloudflare Tunnel → s: Deploy / Setup** to open the setup wizard. You can also open it directly with `herdr plugin action invoke herdr.serve.cloudflare-setup`.

Choose **i: Install / Check cloudflared**, **a: Automatic setup with Cloudflare API** (recommended), **w: Wrangler + API** (experimental), or **h: Manual instructions**. Automatic setup requires:

- The wizard reuses `cloudflared` 2025.4.0+ from the configured path or PATH. If unavailable or too old, automatic setup downloads the latest stable official Cloudflare GitHub release, verifies its SHA-256 digest and executable version, installs it in the plugin config directory under `bin/`, and saves the binary path. No sudo or system-service installation is needed. Use **i** to do just this step. Automatic installation supports Linux/macOS on x64 and arm64; other platforms need a manually installed binary. Download/check failures preserve existing configuration. Updates are not scheduled automatically.
- An active domain in Cloudflare and an unused address such as `herdr.example.com`. After API authorization, the wizard lists accessible domains with their account names: choose a number and enter an address prefix (default `herdr`). Account ID and Zone ID are filled automatically; **m: Advanced** retains manual entry as a fallback. If no domains appear, check domain activation and the token’s Zone Read permission/scope.
- An API token scoped to that account/zone with **Account → Cloudflare Tunnel → Edit**, **Zone → DNS → Edit**, and **Zone → Zone → Read**. Save it in a private (`chmod 600`) file and enter the absolute file path in the wizard, or supply `CLOUDFLARE_API_TOKEN` to the setup process. Do not put the API token in `server.env`.
- For Wrangler mode, a version supporting `wrangler tunnel create` installed on Herdr's PATH. You can install the CLI with `npm install -g wrangler` and check `wrangler tunnel create --help`. Wrangler's Tunnel commands are experimental; its browser login alone does not replace the API token used for DNS and routing here. See [Wrangler Tunnel commands](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/).

To create the API token, open [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens), choose **Create Token → Create Custom Token → Get started**, and name it `Herdr Serve`. Add the three permission rows above. For the account permission, **Cloudflare One Connector: cloudflared → Edit** is also accepted if that is the label shown in the dashboard. Under **Account Resources**, select **Include → Specific account → your account**; under **Zone Resources**, select **Include → Specific zone → your domain**. Choose **Continue to summary → Create Token**, then copy the secret (shown only once). Use the custom token builder: the DNS-only template does not include Tunnel management. [Official instructions](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

In Setup, both **a: Cloudflare API** and **w: Wrangler + API** include step-by-step token creation and file-saving instructions in Chinese, including the dashboard link and permission/resource selections, directly before asking for the token file. Wrangler’s tutorial explains why that flow also needs API authorization. If `CLOUDFLARE_API_TOKEN` is already provided, the tutorial proceeds to domain selection. Save only the token string in a file with mode `600`, using a text editor, and enter its **absolute file path** in Setup. A Global API Key, Tunnel connector token, or Herdr login token is not a substitute for this API token.

The wizard shows the hostname and local target, then `deploy` creates a dedicated named tunnel, configures its loopback route and proxied CNAME, saves a private connector token, and appends Cloudflare settings to `server.env`. It reads the actual configured local port. **Setup does not start the connector**. The completion screen stays open until you press Enter, so standalone setup panes do not disappear before you can read the result. Return to Cloudflare options and select **e: Enable**. Herdr token login is always required; configure Cloudflare Access separately if you need an email/account whitelist.

The API token is not saved by the plugin; only the narrower connector token is saved. A non-secret `cloudflare-deployment.json` journal lets the same setup resume after failures, including a lost create response. Existing conflicting DNS or tunnel routes are refused. Partial cloud resources are kept for recovery rather than deleted on failure. Retrying uses the journal's original method and settings; to change the hostname/account, first inspect and clean up the old deployment in Cloudflare and archive the journal. Stop/Disable does not delete cloud resources. Domain onboarding, API token authorization, Wrangler installation and Access policies remain user-managed. The wizard discovers accounts from the domain list, without requiring an additional account-list permission. See [Cloudflare API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

For manual setup (also printable with `node plugin/manage.js cloudflare-guide`):

1. Select **i: Install / Check cloudflared** in the wizard, or install manually using the [official downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). It must be on Herdr's PATH, or configure an absolute executable path below.
2. In your Cloudflare account, create a **dedicated** Tunnel for this application. Do not also run the dashboard's system-service install command: the plugin will manage its own connector.
3. Add a published application route: your hostname, such as `herdr.example.com`, pointing to `http://127.0.0.1:7681`. If you changed `HERDR_SERVE_PORT`, use that port. The browser must use the root of the hostname, not a path prefix.
4. For account-based restrictions, configure a Cloudflare Access self-hosted application covering the entire hostname and allow only your intended users. Tunnel alone does not impose a visitor identity whitelist. Herdr Serve token login remains required as well.
5. Save **only the Tunnel token** (not the entire install command) in a private file outside the checkout, e.g. `~/.config/herdr/plugins/config/herdr.serve/cloudflare-token`, and set its permissions to `600`. This token is different from the Herdr Serve browser login token. Never paste either token into plugin action arguments or commit it.
6. Set these values in the plugin's `server.env` (use actual absolute paths):

```dotenv
HERDR_SERVE_CLOUDFLARE_ORIGIN=https://herdr.example.com
HERDR_SERVE_CLOUDFLARE_TOKEN_FILE=/home/you/.config/herdr/plugins/config/herdr.serve/cloudflare-token
# Optional if not on PATH:
# HERDR_SERVE_CLOUDFLARED_BINARY=/usr/local/bin/cloudflared
```

The token file defaults to `cloudflare-token` inside the plugin config directory if omitted. The connector receives the file path via `--token-file`; the raw token is not passed in process arguments or plugin state. See [Cloudflare setup](https://developers.cloudflare.com/tunnel/get-started/) and [token-file support](https://developers.cloudflare.com/tunnel/reference/run-parameters/).

```sh
herdr plugin action invoke herdr.serve.cloudflare-on
herdr plugin action invoke herdr.serve.cloudflare-status
herdr plugin action invoke herdr.serve.cloudflare-off
```

In the panel, select Cloudflare or Tailscale first, then use `s` for setup, `e` to enable, or `d` to disable. Use `b` to return and choose another provider. The providers are mutually exclusive: disable the selected provider before enabling the other. The plugin refuses to switch silently. Token files and login sessions are reused, although a new browser hostname requires a new sign-in.

On enable, the plugin restarts its managed bridge with a loopback binding and the configured HTTPS origin. It launches its own `cloudflared` child with an isolated empty local config; routing is stored in Cloudflare (configured by the wizard or dashboard). It does not edit your normal `server.env` or an existing `~/.cloudflared/config.yml`. On disable, it stops its own connector before closing the local HTTP listener and restores your normal bridge configuration. Ordinary plugin Stop also stops the connector. Stop/Disable does not modify or remove unrelated standalone/systemd connectors, Cloudflare DNS records, tunnel registrations or Access policies.

Status reports whether the local connector process is running, **not proof that DNS, remote routing or Access is correct**. Check the tunnel's health in the Cloudflare dashboard and test the URL from another network. Connector output goes to the plugin's `serve.log`. An immediately failing connector triggers startup rollback. A later exited connector is shown as stopped; use `cloudflare-on` to restart it. Forced termination of the parent (for example SIGKILL) can leave an orphan connector; normal plugin Stop is the supported shutdown path. Use a dedicated tunnel and do not run extra connectors for it if disabling this instance is meant to revoke all access.

Tests use a simulated connector executable with a real bridge to verify process ownership, HTTPS cookies, rollback and provider exclusion. Automatic setup tests mock Cloudflare APIs and Wrangler to verify credentials, DNS conflicts, routing, retries and recovery. End-to-end Cloudflare connectivity needs your account, hostname and credentials and has not been verified in this environment.

## Run locally

Requires Linux/macOS, Node.js 22+, npm, and `herdr` on your PATH. Tested against Herdr 0.9.1. `node-pty` is a native dependency; if a prebuilt binary isn't available, installation needs Python and a C/C++ build toolchain.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:7681**. On first start the service generates a private token at `~/.config/herdr-serve/token`. Read it locally and paste it into the sign-in form:

```sh
cat ~/.config/herdr-serve/token
```

Use that exact browser hostname: `localhost` is a different origin. The token is not printed to service logs or placed in URLs/browser storage. The checked **Remember this device for 30 days** option keeps you signed in across browser and bridge restarts, using an HttpOnly cookie. Uncheck it for a 12-hour login that is invalidated by a bridge restart. The raw access token is never saved in browser storage. Clear cookies, sign out, change the server token, or wait for expiry to invalidate a remembered login. Remembered logins are specific to the browser and hostname.

By default, browsers attach to Herdr's default session. To use a named session:

```sh
HERDR_SERVE_SESSION=work npm start
```

The attached client runs as the service's OS user, with access to that user's terminal and files. Share the token only with people who should have that access. This is a personal/trusted-user bridge, not isolated multi-user hosting.

## Access from anywhere

The host must remain powered on, connected, and running Herdr Serve. Mobile browsers can suspend inactive tabs; returning reconnects to the persistent Herdr session. No offline terminal access is provided.

### Private access with Tailscale

Install and connect Tailscale on the host and phone. Publish the local service within your tailnet:

```sh
tailscale serve --bg http://127.0.0.1:7681
```

Use the HTTPS URL printed by Tailscale as the bridge origin, then restart the bridge:

```sh
HERDR_SERVE_ORIGIN=https://your-host.your-tailnet.ts.net npm start
```

Open that HTTPS URL from a device connected to your tailnet, then sign in with your Herdr Serve token. See the [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve) for HTTPS prerequisites and tailnet permissions.

### Public HTTPS with your domain

Point your domain to the host and use the included [Caddyfile](deploy/Caddyfile), replacing `herdr.example.com` with your hostname. Configure the service with that exact origin (no trailing slash):

```sh
HERDR_SERVE_ORIGIN=https://herdr.example.com npm start
```

Run Caddy using your edited configuration. Ports 80 and 443 must reach Caddy; keep port 7681 bound to loopback. Caddy proxies WebSockets and manages HTTPS certificates; see its [reverse proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy). For a host behind NAT, configure routing/port forwarding or use the private-network option above.

The proxy must preserve the browser's `Origin` and cookies. The app uses the configured public origin rather than trusting forwarded headers. HTTP is intended for local use; use HTTPS for remote credentials and terminal traffic. Deployment files are templates: no domain, VPN, or public endpoint is provisioned automatically.

## Run continuously on Linux

A user service template is included. Inspect and adjust `WorkingDirectory` and `ExecStart` for your installation, then:

```sh
mkdir -p ~/.config/systemd/user ~/.config/herdr-serve
cp deploy/herdr-serve.service ~/.config/systemd/user/
cp deploy/server.env.example ~/.config/herdr-serve/server.env
# Edit server.env to set your actual browser origin and optional session.
chmod 600 ~/.config/herdr-serve/server.env
systemctl --user daemon-reload
systemctl --user enable --now herdr-serve
journalctl --user -u herdr-serve -f
```

To keep the user service running after logout and start it at boot, enable lingering for your account with `loginctl enable-linger "$USER"` (your system may require administrator privileges). Run `npm run build` after updating the source, then `systemctl --user restart herdr-serve`.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_SERVE_HOST` | `127.0.0.1` | Listening address |
| `HERDR_SERVE_PORT` | `7681` | Listening port |
| `HERDR_SERVE_ORIGIN` | `http://127.0.0.1:7681` | Exact browser origin; HTTPS enables Secure cookies |
| `HERDR_SERVE_TOKEN` | Generated file | Override access token; at least 32 characters |
| `HERDR_SERVE_TOKEN_FILE` | `~/.config/herdr-serve/token` | Persistent token location |
| `HERDR_SERVE_SESSION_FILE` | `~/.config/herdr-serve/sessions.json` | Remembered-device store |
| `HERDR_SERVE_SESSION` | default session | Named Herdr session |
| `HERDR_SERVE_CLOUDFLARE_ORIGIN` | unset | Plugin-only fixed HTTPS hostname |
| `HERDR_SERVE_CLOUDFLARE_TOKEN_FILE` | plugin config directory + `/cloudflare-token` | Private named-tunnel token file |
| `HERDR_SERVE_CLOUDFLARED_BINARY` | `cloudflared` | Connector executable |
| `HERDR_SERVE_FUNNEL_PORT` | `443` | Plugin-only Funnel HTTPS port: 443, 8443, or 10000 |
| `HERDR_SERVE_BINARY` | `herdr` | Herdr executable path |

Changing the token requires restarting the bridge. To rotate an automatically generated token, stop the bridge, remove its token file, and restart it. Changing the token invalidates all logins on the next start. Remembered logins otherwise survive restarts in `~/.config/herdr-serve/sessions.json`, which contains hashes of session IDs and is written with owner-only permissions. To revoke all devices without changing the token, stop the service, delete that session file, and restart. Use a separate session file for each independently running bridge; sharing it between simultaneous server processes is not supported. The bridge allows eight simultaneous clients. Login throttling is per network peer; behind a local proxy, browsers share that limit.

## Mobile usage and behavior

Tap **Keyboard** for direct terminal typing or use the composer and **Send** to submit a prompt. **Herdr** sends the default `Ctrl+B` prefix; follow it with a Herdr action key. If your prefix is customized, use Ctrl with the appropriate key. **Ctrl** modifies the next single character. Text size and terminal width can be changed without restarting the session, and these preferences are saved locally. **Fit** adapts columns to the display. **80 cols** and **120 cols** preserve a wider terminal with horizontal swiping. **Focus** hides the header to leave more space for output; tap **Exit focus** to restore it. The layout follows the visible viewport above the soft keyboard, and the Keyboard button can also dismiss it. On narrow screens the keys are arranged in two touch-friendly rows. The composer grows to accommodate multiline input.

The full terminal interface is preserved rather than translated into native web controls. Very narrow screens can still constrain complex pane layouts. Tabs viewed by multiple clients follow Herdr's own size/ownership rules: interacting with the same tab on a phone can resize its panes for a desktop viewer. See [Herdr's client/server concepts](https://herdr.dev/docs/concepts/).

Terminal graphics protocols, native desktop clipboard integration, and perfect behavior of every mobile IME are not guaranteed. Browser refresh reconnects a fresh client; it does not restore client-local scroll position. Connection failures never automatically replay typed commands. There is no separate read-only audience role.

## Development and checks

```sh
npm run build
npm run check
npm test
HERDR_SERVE_LIVE_TEST=1 node test/live-smoke.js
```

Unit/integration tests cover HTTP authentication, cookie revocation, origin enforcement, WebSocket authorization, resizing, Unicode input, backpressure, malformed messages, expiry, and connection limits. The opt-in smoke test creates a uniquely named Herdr session, verifies streamed ANSI output and persistence after browser disconnect, then stops and deletes only that test session.

The backend and live smoke test have been exercised in the development environment. Desktop/mobile visual verification remains outstanding because no browser was connected.

## Architecture

`Browser (xterm.js) ↔ authenticated WebSocket ↔ node-pty ↔ herdr client ↔ persistent Herdr server`

The web server launches only the configured Herdr binary with an optional server-configured session name. Browser requests cannot choose executables or shell arguments. Each socket owns its attached client and kills only that client on disconnect. Terminal acknowledgements apply backpressure for slow browsers. Credentials never appear in WebSocket query strings; sign-out revokes active connections.


## Publishing and marketplace discovery

Herdr discovers public GitHub repositories tagged with the **herdr-plugin** topic when their default branch contains a valid `herdr-plugin.toml`. This repository keeps its manifest at the root. There is no separate plugin upload; the marketplace index refreshes about every 30 minutes. Listing is automatic and is not an endorsement or review by Herdr. See the [official marketplace instructions](https://herdr.dev/docs/marketplace/).

Before publishing a release, run `npm ci`, `npm run build`, `npm run check`, and `npm test`. Keep the version in `package.json`, `package-lock.json`, and `herdr-plugin.toml` aligned. CI runs the build and tests on Node.js 22 / Linux. Cloudflare and Tailscale tests use simulated providers, and macOS support is not yet verified by CI. A running connector process does not prove that a public tunnel is reachable; network/proxy failures can still cause Cloudflare 1033 errors.

Runtime credentials and state belong in the user configuration/state directories, outside this repository. Do not commit real `server.env` files, API or login tokens, remembered-device stores, or logs. The files under `deploy/` ending in `.example` are placeholders for documentation.

## License

MIT — see [LICENSE](LICENSE). This is a community project and is not an official Herdr product.
