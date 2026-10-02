import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Invoice workspace",
  description: "A local workspace for investigating fictional invoices and reviewing payment records.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en"><body>{children}</body></html>;
}
