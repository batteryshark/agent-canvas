# Rights and attribution

Owned Agent Canvas code and documentation are covered by the [MIT licence](LICENSE), copyright 2026 batteryshark.

## Artwork and captures

The comic mascot images in `assets/workstack-mark*.png` are AI-generated artwork, offered under MIT to the extent applicable. No exclusive copyright is claimed in generated material. The 32-pixel image is a downsampled preview of the badge. These terms don't grant rights in other projects' trademarks or reference material.

The existing Canvas demonstration captures in `docs` are included with the owned documentation. They contain synthetic examples; see [image notes](docs/SCREENSHOTS.md). Third-party components visible in the interface retain their own rights.

## Dependencies and generated distributions

[OpenUI](https://github.com/thesysdev/openui) by Thesys supplies the language, renderer and standard component library under MIT. The two-way-interface concept also draws on Thesys's [Open Intelligent UI](https://github.com/thesysdev/open-intelligent-ui) demo. Canvas supplies the agent integration, persistence, delivery and HTML bridge.

The lockfile records dependency versions and declared licences. OpenCode and OpenChamber APIs, React, OpenUI and its dependencies, bundled Tailwind/Chart.js/D3/Mermaid libraries, and any copied or inlined fonts/assets retain their respective terms. The MIT licence for owned code doesn't replace those terms or grant blanket rights to dependency assets.

`scripts/build.mjs` collects licence texts for bundled packages and copied libraries into `THIRD_PARTY_NOTICES.md` in both generated folders. It fails when it cannot find or reconstruct required licence text. Preserve those notices when redistributing bundles, and review dependency notices and any font/media obligations for the actual output. This source-only candidate includes no dependency binaries or generated distribution; its notice generator hasn't been executed during preparation.
