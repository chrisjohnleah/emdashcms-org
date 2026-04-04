declare namespace App {
  interface Locals {
    /** Set by auth middleware when a valid session JWT is present */
    author?: {
      id: string;
      githubId: number;
      username: string;
    };
  }
}
