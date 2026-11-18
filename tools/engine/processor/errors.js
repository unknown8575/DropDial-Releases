// A problem the person can act on; its message is shown as it is.
export class UserError extends Error {
  constructor(message) { super(message); this.user = true; }
}
