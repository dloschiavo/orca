import {
  faUser, faDatabase, faDesktop, faDraftingCompass, faBug,
  faPen, faMap, faSitemap, faGear, faRobot, faCompass, faClipboardList,
  faBroom, faWrench, faVial, faMagnifyingGlass, faBoxArchive, faShield,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

export const USER_LABEL = "david";

export type AgentDisplay = { icon: IconDefinition; color: string };

const KNOWN_AGENTS: Record<string, AgentDisplay> = {
  "scrum-master": { icon: faSitemap,         color: "var(--ag-scrum)"      },
  "spec-writer":  { icon: faPen,             color: "var(--ag-spec)"       },
  "architect":    { icon: faDraftingCompass, color: "var(--ag-architect)"  },
  "frontend":     { icon: faDesktop,         color: "var(--ag-frontend)"   },
  "backend":      { icon: faDatabase,        color: "var(--ag-backend)"    },
  "scraper":      { icon: faCompass,         color: "var(--ag-scraper)"    },
  "ui-polisher":  { icon: faBroom,           color: "var(--ag-polisher)"   },
  "refactorer":   { icon: faWrench,          color: "var(--ag-refactor)"   },
  "test-writer":  { icon: faVial,            color: "var(--ag-test)"       },
  "reviewer":     { icon: faMap,             color: "var(--ag-reviewer)"   },
  "explorer":     { icon: faMagnifyingGlass, color: "var(--ag-explorer)"   },
  "classifier":   { icon: faClipboardList,   color: "var(--ag-classifier)" },
  "compactor":    { icon: faBoxArchive,      color: "var(--ag-compactor)"  },
  "auditor":      { icon: faShield,          color: "var(--ag-auditor)"    },
  "qa-tester":    { icon: faBug,             color: "var(--ag-qa)"         },
};

export function resolveAgentDisplay(name: string): AgentDisplay {
  if (!name || name === "user" || name === USER_LABEL) {
    return { icon: faUser, color: "var(--ag-human)" };
  }
  return KNOWN_AGENTS[name] ?? { icon: faRobot, color: "var(--ag-impl)" };
}
