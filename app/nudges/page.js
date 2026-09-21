import { redirect } from "next/navigation";
// The old Nudges page is gone: its content now lives in the Tracker (Run log, Excluded, Pause) and Frequency.
export default function Page() { redirect("/tracker"); }
