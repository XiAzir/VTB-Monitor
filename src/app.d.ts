declare global {
  namespace App {
    interface Locals {
      adminSession: { adminId: string; username: string; forcePasswordChange: boolean } | null;
    }
  }
}

export {};
