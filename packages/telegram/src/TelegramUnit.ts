import type { Unit } from "#core/shared/Supervisor";

/**
 * Its own module so `pim --mode telegram --install` can describe the daemon
 * without loading the bot, and with it grammy and every session it drags in.
 */
export const TelegramUnit: Unit = {
  mode: "telegram",
  description: "Pim Telegram daemon",
};
