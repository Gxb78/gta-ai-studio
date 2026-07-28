// Section repliable de l'inspecteur.
//
// L'inspecteur empile beaucoup de réglages pour un seul clip. Les replier
// permet de garder sous les yeux ceux qu'on touche, sans faire défiler. L'état
// ouvert/fermé est de l'état de vue local : il ne va pas dans le projet, et il
// n'est volontairement pas partagé entre les sections — chacune se souvient de
// la sienne tant que le panneau reste monté.
//
// Le résumé (`summary`) affiche la valeur courante quand la section est fermée :
// sans lui, replier reviendrait à cacher de l'information.

import { useState } from "react";
import { Icon } from "./Icon";

interface Props {
  title: string;
  /** Valeur courante, montrée uniquement section fermée. */
  summary?: string;
  /** Note discrète à droite du titre, toujours visible. */
  note?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function InspectorSection(props: Props) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);

  return (
    <section className={"inspector-section" + (open ? " open" : "")}>
      <button
        type="button"
        className="section-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Icon name="chevron" size={14} />
        <h3>{props.title}</h3>
        {props.note && <span className="section-note muted">{props.note}</span>}
        {!open && props.summary && (
          <span className="section-summary">{props.summary}</span>
        )}
      </button>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}
