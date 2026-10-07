# Effect barrels

Effect is imported only through its barrels: `effect`, `effect/http` and `effect/http-api`, and on the server `effect/ai`, `effect/cli` and `effect/encoding`. A page whose import map serves those three then loads `Action` and `ActionHttp` beside one copy of Effect, where a deep specifier the map lacks would bundle a second. This reverses ebfb5e4's import of a module such as `OpenApi` from its own path, which esbuild would otherwise keep whole, under a 2 kB bundle budget that 2b6b2cf dropped. Lost: esbuild's output grows by about 5.6 kB gzipped; Vite+'s is unchanged.
