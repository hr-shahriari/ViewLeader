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

## Duplex IFC fixture

See [`models/NOTICE.md`](./models/NOTICE.md) for the pinned buildingSMART
source commit, Creative Commons Attribution 4.0 license, size, and checksum.
