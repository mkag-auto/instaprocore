import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Procore Photo Feed",
  description: "Instagram-style Procore project photo feed for DAKboard"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
