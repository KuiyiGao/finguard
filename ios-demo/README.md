# FinGuard iOS development demo

Independent Capacitor 8.5.3 wrapper of the existing phone UI. No shared web dependency
changes. It loads the team's server on the Mac (port 8787, path /app): the same API, modes
and keys as the desk and console, so with release/.env the phone gets the Gemini agent, live
Nessie reads and iMessage approvals. The Mac and iPhone must stay on the same network. It is
not an offline release build or App Store submission.

## Prepared

- Separate package/lockfile and generated Swift Package Manager Xcode project.
- Bundled copy of the web dist; local fallback route selects /app.
- Development server URL generated from active en* IPv4 or IOS_DEMO_URL.
- Local-network explanation, development WebView HTTP exception, portrait phone.
- Server on port 8787 (app and API on one port). STEWARD_OFFLINE=1 runs the isolated mock API (8799) behind a preview (5190) for offline rehearsal only.
- Simulator and device-architecture unsigned builds succeeded with Xcode 27.0.
- Device build signed and installed on the connected iPhone; the user confirmed the app opens. Personal signing settings are local to each developer.

## Run and update

Double-click Update FinGuard Demo.command to build the current web code, prepare the
network URL and sync iOS. Then use Xcode Run to install. Double-click
Start FinGuard Demo.command to start the server (it reuses one already answering on port
8787) and print its modes.
Build web first after UI changes. Run node prepare.mjs and npx cap sync ios after
changing the Mac IP; then rebuild the app. This wrapper copies existing compiled
assets; it never changes the shared web package or gateway contract.

Open ios/App/App.xcodeproj in Xcode. Select the App target, configure automatic
signing with your own Team, choose your iPhone, and Run. A Personal Team can be
used for local testing when its provisioning limitations are acceptable.
Remove the development server URL and HTTP exception before production deployment;
packaged release assets additionally need explicit backend and SSE addressing.

## Without Xcode: Safari

The same app runs in Safari: with the server running on the Mac, open
`http://<Mac address>:8787/app` on the iPhone (prepare.mjs prints the address), then Share >
Add to Home Screen. The gateway uses demo roles, not real sign-in, so prefer a network you
trust: join the Mac to the iPhone's Personal Hotspot if the venue Wi-Fi isolates devices.

## Phone instructions

1. Connect the iPhone with a data cable. Unlock it and tap Trust when prompted.
2. Settings > Privacy & Security > Developer Mode: enable, restart, unlock,
   confirm Turn On. Keep the cable connected.
3. If asked to trust your development signing identity: Settings > General >
   VPN & Device Management, choose your developer identity and follow the prompt.
4. Launch FinGuard, allow the local-network connection if prompted, and keep
   the Mac awake on the same network. The mock agreement is in the app.

The portable wrapper sources belong in Git; generated network configuration and personal signing remain local.

## Repository integration and API status

Commit this folder's package.json, package-lock.json, prepare.mjs, mock-server.mjs,
startup script, README, and native ios project sources. Do not commit dependencies,
compiled www/public assets, generated Capacitor configuration, demo-data, logs,
certificates, provisioning profiles, or Xcode user settings. Every developer chooses
their own signing Team. Build the web app before preparing and syncing the wrapper.

By default the phone talks to the team's server with the modes in release/.env; the wrapper
sets no modes of its own. /api/health (and the desk's Data sources panel) shows which sources
are live. STEWARD_OFFLINE=1 keeps the old isolated mock (Nessie and RAG mock, agent replay,
Spectrum off) for rehearsing without keys or network. Shared web and server
code remains the source of the UI and API behavior; the wrapper adds no separate
financial business logic. Mac network address changes require prepare, cap sync,
and rebuilding/reinstalling. A working screen alone does not verify every flow.

UI polish belongs to T41; live bank read-only verification belongs to T33/T6.
Coordinate those changes through TASKS.md and PLAN.md rather than duplicating
shared UI or changing the team's server modes from the iOS wrapper.
