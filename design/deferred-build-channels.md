# Deferred build channels

`implement`'s build channels are `Deferred<T>`, `[T][T extends unknown ? 0 : never]`, rather than `NoInfer<T>`. Either keeps an implementation written inside a surface's arguments from inferring them from the surface's parameter, where they would be `unknown`. `NoInfer<A | B>` also survives into a layer's requirements, where providing `A` and `B` in two `Layer.provide` calls leaves it owed, and shows in every hover; `Deferred` reads as `A | B` once inferred.
