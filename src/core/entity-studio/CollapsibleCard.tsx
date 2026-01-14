import type { ComponentChildren } from "preact";

interface CollapsibleCardProps {
  summary: ComponentChildren;
  onRemove?: () => void;
  children?: ComponentChildren;
}

export const CollapsibleCard = ({
  summary,
  onRemove,
  children,
}: CollapsibleCardProps) => {
  return (
    <article>
      <details style={{ margin: 0 }} open>
        <summary style={{ position: "relative" }}>
          {summary}
          {onRemove && (
            <button
              className="secondary"
              style={{ position: "absolute", right: "2rem" }}
              onClick={() => onRemove()}
            >
              Remove
            </button>
          )}
        </summary>
        {children}
      </details>
    </article>
  );
};
