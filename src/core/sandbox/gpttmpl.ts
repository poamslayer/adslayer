/**
 * Gives a GPO's security template (MACHINE\Microsoft\Windows NT\SecEdit\GptTmpl.inf) a shape a
 * script can filter. The helper parses the INI text and names the SIDs it finds; this runs and is
 * tested on every OS. Issue #12.
 */

/** What the helper reads: each section's lines as [key, value], in order, and a name per SID. */
export interface SecurityTemplate {
  sections: Record<string, Array<[string, string]>>;
  names: Record<string, string>;
}

export interface Principal {
  sid: string | null;
  name: string | null;
}

export interface SecuritySettings {
  systemAccess: Record<string, number | string>;
  eventAudit: Record<string, number | string>;
  privilegeRights: Record<string, Principal[]>;
  groupMembership: Array<{ group: Principal; members?: Principal[]; memberOf?: Principal[] }>;
  registryValues: Record<string, { type: number; value: number | string }>;
  other: Record<string, Record<string, string>>;
}

const DROPPED = new Set(["Unicode", "Version"]);

/** A whole number as a number; anything else as text, without the quotes the template puts round names. */
function scalar(v: string): number | string {
  if (/^-?\d+$/.test(v)) return Number(v);
  return /^".*"$/.test(v) ? v.slice(1, -1) : v;
}

function principal(entry: string, names: Record<string, string>): Principal {
  const e = entry.trim();
  if (e.startsWith("*")) {
    const sid = e.slice(1);
    return { sid, name: names[sid] ?? null };
  }
  return { sid: null, name: e };
}

function principals(list: string, names: Record<string, string>): Principal[] {
  return list.split(",").map((p) => p.trim()).filter(Boolean).map((p) => principal(p, names));
}

export function shapeSecuritySettings(raw: SecurityTemplate): SecuritySettings {
  const out: SecuritySettings = { systemAccess: {}, eventAudit: {}, privilegeRights: {}, groupMembership: [], registryValues: {}, other: {} };
  const groups = new Map<string, SecuritySettings["groupMembership"][number]>();
  for (const [section, lines] of Object.entries(raw.sections)) {
    if (DROPPED.has(section)) continue;
    for (const [key, value] of lines) {
      switch (section) {
        case "System Access":
          out.systemAccess[key] = scalar(value);
          break;
        case "Event Audit":
          out.eventAudit[key] = scalar(value);
          break;
        case "Privilege Rights":
          out.privilegeRights[key] = principals(value, raw.names);
          break;
        case "Group Membership": {
          // "*S-1-5-32-544__Members" or "__Memberof"; one group may have both lines.
          const m = /^(.*)__(Members|Memberof)$/i.exec(key);
          if (!m) break;
          let g = groups.get(m[1]);
          if (!g) {
            g = { group: principal(m[1], raw.names) };
            groups.set(m[1], g);
            out.groupMembership.push(g);
          }
          g[m[2].toLowerCase() === "members" ? "members" : "memberOf"] = principals(value, raw.names);
          break;
        }
        case "Registry Values": {
          // "type,value". A string value may hold commas, so only the first comma splits.
          const at = value.indexOf(",");
          const type = Number(value.slice(0, at));
          const rest = at === -1 ? "" : value.slice(at + 1);
          out.registryValues[key] = { type, value: type === 4 && /^-?\d+$/.test(rest) ? Number(rest) : /^".*"$/.test(rest) ? rest.slice(1, -1) : rest };
          break;
        }
        default:
          (out.other[section] ??= {})[key] = value;
      }
    }
  }
  return out;
}
