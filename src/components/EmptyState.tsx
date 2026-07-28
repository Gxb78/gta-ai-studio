// État vide d'un panneau.
//
// Une phrase grise seule au milieu d'un panneau vide se lit comme une panne :
// on ne sait pas si l'application charge, a échoué, ou attend un geste. Une
// icône, une phrase qui dit CE QU'IL Y A (rien, et c'est normal) et une qui dit
// QUOI FAIRE lèvent les trois doutes d'un coup.

import { Icon, type IconName } from "./Icon";

interface Props {
  icon: IconName;
  /** Le constat, en une ligne. */
  title: string;
  /** Le geste qui remplit ce panneau. Facultatif : parfois il n'y en a pas. */
  hint?: string;
}

export function EmptyState({ icon, title, hint }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p className="empty-title">{title}</p>
      {hint && <p className="muted small-text">{hint}</p>}
    </div>
  );
}
