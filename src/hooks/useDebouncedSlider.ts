// Curseur continu (fondu, volume, cadrage, échelle…) qui ne doit empiler
// QU'UNE entrée d'historique par réglage, pas une par tick de `onChange`.
//
// Un `<input type="range">` natif déclenche `onChange` en continu pendant
// qu'on le tire ; si chaque appel dispatche directement (comme c'était le
// cas), resserrer un fondu de 0 à 2 s empile des dizaines d'entrées pour un
// seul réglage logique — Ctrl+Z n'en annule alors qu'un pas minuscule à la
// fois. Même principe déjà appliqué au geste clavier de la zone de zoom
// (PreviewStage.tsx) : on prévisualise en local, on ne committe qu'une fois
// le curseur resté silencieux `delayMs`, ou tout de suite au relâchement.

import { useEffect, useRef, useState } from "react";

const DEFAULT_DELAY_MS = 400;

export function useDebouncedSlider(
  committedValue: number,
  commit: (value: number) => void,
  /**
   * Doit changer quand LA CIBLE change (un autre clip sélectionné, par
   * exemple) : un réglage en attente pour l'ancienne cible ne doit jamais
   * s'appliquer à la nouvelle.
   */
  resetKey: string | number,
  delayMs = DEFAULT_DELAY_MS,
) {
  const [pending, setPending] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = () => {
    clearTimer();
    const value = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (value !== null) commit(value);
  };

  // Changer de cible abandonne un réglage en attente plutôt que de
  // l'appliquer à la mauvaise chose.
  useEffect(() => {
    clearTimer();
    pendingRef.current = null;
    setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Démontage en plein réglage (fermeture du panneau, par exemple) : on
  // committe ce qui restait plutôt que de le perdre en silence.
  useEffect(
    () => () => {
      clearTimer();
      if (pendingRef.current !== null) commit(pendingRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChange = (value: number) => {
    pendingRef.current = value;
    setPending(value);
    clearTimer();
    timerRef.current = window.setTimeout(flush, delayMs);
  };

  return {
    /** Valeur à afficher : la préview locale si un réglage est en cours, sinon la valeur committée. */
    value: pending ?? committedValue,
    onChange,
    /** À appeler au relâchement (`onPointerUp`/`onBlur`) : committe tout de suite plutôt que d'attendre le silence. */
    commitNow: flush,
    /**
     * Abandonne un réglage en attente SANS le committer — pour un bouton qui
     * fixe la valeur autrement (« Retirer les fondus », par exemple) pendant
     * qu'un tirage de ce même curseur est encore en attente : sans cet appel,
     * le minuteur en cours committerait la valeur périmée par-dessus juste
     * après, silencieusement.
     */
    cancel: () => {
      clearTimer();
      pendingRef.current = null;
      setPending(null);
    },
  };
}
