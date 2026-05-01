import { redirect } from "next/navigation";

export default function LevelsReviewRedirect() {
  redirect("/dashboard/alerts?view=review");
}
