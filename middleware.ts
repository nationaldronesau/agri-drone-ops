import { withAuth } from "next-auth/middleware";

const PUBLIC_PATHS = ["/", "/auth", "/unauthorized"];
const authSecret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const hasAuthSecret = Boolean(authSecret);

export default withAuth(
  function middleware() {
    // Auth gating is handled by callbacks.authorized below.
  },
  {
    secret: authSecret,
    callbacks: {
      authorized: ({ token, req }) => {
        const pathname = req.nextUrl.pathname;
        const isPublicPath = PUBLIC_PATHS.some(
          (path) => pathname === path || (path !== "/" && pathname.startsWith(path))
        );

        if (isPublicPath) return true;
        if (!hasAuthSecret) {
          // Avoid locking users out when auth secret is missing in runtime env.
          return true;
        }
        return Boolean(token);
      },
    },
    pages: {
      signIn: "/auth/signin",
    },
  }
);

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
