import {
  faUser, faDatabase, faDesktop, faDraftingCompass, faBug,
  faPen, faMap, faSitemap, faGear, faRobot, faCompass, faClipboardList,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

export const USER_LABEL = "david";

export type ActorColors = { text: string; bg: string };

export function agentColors(name: string): ActorColors {
  const n = (name || "").toLowerCase();
  if (n === USER_LABEL || n === "user")           return { text: "text-blue-400",    bg: "bg-blue-500/25" };
  if (n.includes("triage"))                       return { text: "text-purple-400",  bg: "bg-purple-500/25" };
  if (n.includes("architect"))                    return { text: "text-orange-400",  bg: "bg-orange-500/25" };
  if (n.includes("backend"))                      return { text: "text-green-400",   bg: "bg-green-500/25" };
  if (n.includes("frontend"))                     return { text: "text-cyan-400",    bg: "bg-cyan-500/25" };
  if (n.includes("qa"))                           return { text: "text-red-400",     bg: "bg-red-500/25" };
  if (n.includes("spec"))                         return { text: "text-yellow-400",  bg: "bg-yellow-500/25" };
  if (n.includes("explor"))                       return { text: "text-emerald-400", bg: "bg-emerald-500/25" };
  if (n.includes("compass") || n.includes("nav")) return { text: "text-sky-400",     bg: "bg-sky-500/25" };
  if (n.includes("plan") || n.includes("list"))   return { text: "text-amber-400",   bg: "bg-amber-500/25" };
  if (n.includes("system") || !name)              return { text: "text-muted",       bg: "bg-surface2" };
  return { text: "text-slate-400", bg: "bg-slate-500/25" };
}

export function agentIcon(name: string): IconDefinition {
  const n = (name || "").toLowerCase();
  if (n === USER_LABEL || n === "user") return faUser;
  if (n.includes("backend"))   return faDatabase;
  if (n.includes("frontend"))  return faDesktop;
  if (n.includes("architect")) return faDraftingCompass;
  if (n.includes("qa"))        return faBug;
  if (n.includes("spec"))      return faPen;
  if (n.includes("explor"))    return faMap;
  if (n.includes("triage"))    return faSitemap;
  if (n.includes("system"))    return faGear;
  if (n.includes("compass") || n.includes("nav")) return faCompass;
  if (n.includes("plan") || n.includes("list"))   return faClipboardList;
  return faRobot;
}
