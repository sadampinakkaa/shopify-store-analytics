import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // Always redirect directly to the Store Overview dashboard, preserving all query params
  return redirect(`/app${url.search}`);
};

export default function IndexRoute() {
  return null;
}
