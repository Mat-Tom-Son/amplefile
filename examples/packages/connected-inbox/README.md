# Connected inbox full-trust Pi Extension example

This demonstrates the native Pi compatibility lane: `package.json` declares a full-trust Extension, `index.ts` owns executable or network behavior, and the adjacent `surface.json` contributes host-rendered navigation and views.

The sample tool accepts HTTPS JSON endpoints, caps responses at 128 KB, and returns the result to the agent. It deliberately does not store credentials or claim a real email connection. Binding live tool data, connection state, refresh, and permissioned actions into the surface is the next host-bridge contract.

Install this directory through the normal local-package flow in **Skills & Extensions** only when its source is trusted. Package scope determines whether it is Everywhere or belongs to This Connected Folder only; a project-scoped package loads while its folder is registered as a Connected Folder.

The manifest is not a sandbox for the Extension. Extension code runs with the current user's permissions and must disclose its endpoints, credentials, and side effects during package review.
