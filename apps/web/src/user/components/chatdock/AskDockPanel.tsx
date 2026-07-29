import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { ParkedPage } from '../../parked/ParkedPage';

/**
 * The dock's "Ask BetterTrack" tab — the AI slot (PROJECTPLAN.md §6 Ask, the
 * `parked.ask` registry entry).
 *
 * It renders the SAME parked surface as the `/ask` page (`ParkedPage page="ask"`)
 * rather than a second copy of the promise, so the dock can never drift from the
 * page or invent a claim the product doesn't make yet. Under it sits a disabled
 * composer: it shows where the AI conversation will live without pretending it
 * works. There is no submit path and no canned response — the field cannot be
 * typed into and the Send button is inert.
 */
export function AskDockPanel() {
  const t = useT();
  return (
    <div className="bt-chatdock__pane">
      <div className="bt-chatdock__scroll">
        <div className="bt-chatdock__parked">
          <ParkedPage page="ask" />
        </div>
      </div>
      {/* Not a <form>: nothing can be submitted, so there is no handler to
          write and no way for a stray Enter to imply an answer is coming. */}
      <div className="bt-chatdock__composer bt-t-rule">
        <textarea
          aria-describedby="bt-chatdock-ask-hint"
          className="bt-textarea max-h-32 flex-1 resize-none"
          disabled
          placeholder={t('chatdock.ask.composerPlaceholder')}
          rows={1}
          style={{ minHeight: 34 }}
        />
        <Button className="shrink-0" disabled type="button" variant="primary">
          {t('social.chat.send')}
        </Button>
      </div>
      <p className="bt-meta bt-chatdock__hint" id="bt-chatdock-ask-hint">
        {t('chatdock.ask.hint')}
      </p>
    </div>
  );
}
