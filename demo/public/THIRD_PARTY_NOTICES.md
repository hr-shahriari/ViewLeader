# Demo third-party artifact notices

The production example bundles the following pinned, redistributable assets.
Their package versions are exact entries in the repository lockfile.

## web-ifc 0.0.74

- Package/source: `web-ifc@0.0.74`, <https://github.com/ThatOpen/engine_web-ifc>
- License: Mozilla Public License 2.0 (`node_modules/web-ifc/LICENSE.md`)
- Bundled source artifact: `web-ifc/web-ifc.wasm`
- Source artifact SHA-256: `385bfc5bdccb8557476b7fb8e7dfa4bc2136cd0ebdfba96adf5447f357246f4d`
- Source artifact size: 1,320,042 bytes

Vite copies the WASM into a content-hashed production asset and builds the
host-owned module worker from `src/ifc-worker.ts`. `web-ifc` is a demo-only
dependency; it is not part of `viewleader`.

## Inter font 5.2.8

- Package/source: `@fontsource/inter@5.2.8`, <https://github.com/fontsource/font-files/tree/main/fonts/google/inter>
- Font license: SIL Open Font License 1.1 (`node_modules/@fontsource/inter/LICENSE`)
- Package publish hash: `a54a382a50f4a74f`
- Latin 400 WOFF2 SHA-256: `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc`
- Latin 600 WOFF2 SHA-256: `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a`
- Latin 700 WOFF2 SHA-256: `6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491`

## Duplex IFC fixture

See [`models/NOTICE.md`](./models/NOTICE.md) for the pinned buildingSMART
source commit, Creative Commons Attribution 4.0 license, size, and checksum.
