import type { EventMap, EventHandler } from '../types.js'

/**
 * Minimal, zero-dependency typed event emitter.
 */
export class Emitter {
  private handlers = new Map<string, Set<EventHandler<keyof EventMap>>>()

  on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as EventHandler<keyof EventMap>)
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    this.handlers.get(event)?.delete(handler as EventHandler<keyof EventMap>)
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        ;(handler as EventHandler<K>)(payload)
      } catch {
        // Swallow handler errors to avoid crashing the request pipeline
      }
    }
  }
}
