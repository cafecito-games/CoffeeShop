import {
  agentAvatarColors,
  agentAvatarShapes,
  type AgentAvatarColor,
  type AgentAvatarShape
} from "@coffee-shop/protocol";

type AvatarSize = "sm" | "md" | "lg" | "xl";

function AvatarGlyph({ shape }: { shape: AgentAvatarShape }) {
  if (shape === "bean") return <><path d="M36 8C24 2 8 12 9 28c1 12 13 15 22 8 9-7 11-22 5-28Z" /><path d="M31 10c-3 7-10 8-13 14-3 6-1 10 1 14" /><path className="avatar-eye" d="M19 25h3v5h-3zM27 22h3v5h-3z" /></>;
  if (shape === "moka") return <><path d="m16 7-4 9 3 24h20l3-24-5-9H16Z" /><path d="M13 17h24M15 28h21M37 18h5v13h-6" /><path className="avatar-eye" d="M20 20h3v5h-3zM28 20h3v5h-3z" /></>;
  if (shape === "kettle") return <><path d="M13 18h24l3 21H10l3-21Z" /><path d="M18 18c0-7 14-7 14 0M37 21l8 3-6 6M11 22C4 24 4 34 10 36" /><path className="avatar-eye" d="M19 25h3v5h-3zM28 25h3v5h-3z" /></>;
  if (shape === "grinder") return <><path d="M13 19h22l-3 22H16l-3-22Z" /><path d="M16 19 18 7h12l2 12M29 8h11v5" /><circle cx="24" cy="31" r="5" /><path className="avatar-eye" d="M20 24h2v3h-2zM27 24h2v3h-2z" /></>;
  if (shape === "pour-over") return <><path d="M11 13h26L31 29H17l-6-16ZM17 29h14l4 11H13l4-11Z" /><path d="M17 8h14" /><path className="avatar-eye" d="M19 18h3v5h-3zM27 18h3v5h-3z" /></>;
  return <><path d="M10 17h24v11c0 7-4 11-12 11s-12-4-12-11V17Z" /><path d="M34 21h4c4 0 5 3 5 5s-2 5-7 5h-2M17 11c-3-3 2-5 0-8M26 11c-3-3 2-5 0-8" /><path className="avatar-eye" d="M17 24h3v6h-3zM26 24h3v6h-3z" /></>;
}

export function CoffeeAvatar({
  shape = "cup",
  color = "amber",
  size = "md",
  label,
  state
}: {
  shape?: AgentAvatarShape;
  color?: AgentAvatarColor;
  size?: AvatarSize;
  label?: string;
  state?: string;
}) {
  return (
    <span className={`coffee-avatar avatar-${size} avatar-${color} ${state ? `state-${state}` : ""}`} aria-label={label} role={label ? "img" : undefined}>
      <svg viewBox="0 0 48 48" aria-hidden="true"><g className="avatar-stroke"><AvatarGlyph shape={shape} /></g></svg>
    </span>
  );
}

export function AvatarPicker({
  shape,
  color,
  onShape,
  onColor,
  compact = false
}: {
  shape: AgentAvatarShape;
  color: AgentAvatarColor;
  onShape: (shape: AgentAvatarShape) => void;
  onColor: (color: AgentAvatarColor) => void;
  compact?: boolean;
}) {
  return (
    <div className={`avatar-picker ${compact ? "compact" : ""}`}>
      {!compact && <CoffeeAvatar shape={shape} color={color} size="xl" />}
      <div className="avatar-shapes" aria-label="Coffee avatar" role="group">
        {agentAvatarShapes.map((option) => (
          <button type="button" key={option} className={shape === option ? "selected" : ""} onClick={() => onShape(option)} aria-pressed={shape === option} aria-label={option.replace("-", " ")}>
            <CoffeeAvatar shape={option} color={color} size="sm" />
          </button>
        ))}
      </div>
      <div className="avatar-colors" aria-label="Avatar color" role="group">
        {agentAvatarColors.map((option) => (
          <button type="button" key={option} className={`color-${option} ${color === option ? "selected" : ""}`} onClick={() => onColor(option)} aria-pressed={color === option} aria-label={option} />
        ))}
      </div>
    </div>
  );
}
