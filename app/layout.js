import "./globals.css";
import Nav from "./nav";
export const metadata = { title: "Ops Outreach" };
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
