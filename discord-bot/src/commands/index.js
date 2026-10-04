// Every slash command the bot has.
import * as setupserver from "./setupserver.js";
import { commands as moderation } from "./moderation.js";

export const commands = [setupserver, ...moderation];
