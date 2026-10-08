// Errors shared by the layers that must not import each other (app.js imports llm.js, llm.js needs UserError).

/** Bad input from the user (maps to HTTP 400, or a clean message in the CLI). */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
