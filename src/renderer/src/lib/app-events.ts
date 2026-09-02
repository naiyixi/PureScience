// Cross-cutting DOM events dispatched between leaf components and App-level dialogs. Kept in a
// leaf module (no UI imports) so any component can reference an event name without pulling in the
// dialog's full dependency tree.
export const GLOBAL_SEARCH_OPEN_EVENT = 'purescience:open-global-search'
