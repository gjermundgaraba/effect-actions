import { Context } from "effect";

/**
 * The room an instance holds. Each room is one Durable Object, reached by its name, so this is
 * a startup service: one value for the instance's whole life, unlike the caller, which every
 * message names again.
 */
export class Room extends Context.Service<Room, string>()("chat-rooms/Room") {}
