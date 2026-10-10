import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { BroadcastAudience, BroadcastButton, BroadcastDto, BroadcastInput } from '@contract/api.ts';
import { LOCALES, LOCALE_LABELS } from '@contract/constants.ts';
import type { Locale } from '@contract/constants.ts';
import { api, apiUpload } from '../api.ts';
import { dateTime } from '../format.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Button, ErrorState, Sheet, Skeleton, State, errorMessage, useToast } from '../ui/kit.tsx';
import { PageHead, useAction } from './shared.tsx';

interface Media {
  mediaKind: 'photo' | 'voice';
  mediaFileId: string;
  name: string;
}

/** Кнопки форматирования: оборачивают выделенный текст в тег разметки Telegram. */
const FORMATS: { label: string; title: string; open: string; close: string; style?: React.CSSProperties }[] =
  [
    { label: 'Ж', title: 'Жирный', open: '<b>', close: '</b>', style: { fontWeight: 900 } },
    { label: 'К', title: 'Курсив', open: '<i>', close: '</i>', style: { fontStyle: 'italic' } },
    { label: 'Ч', title: 'Подчёркнутый', open: '<u>', close: '</u>', style: { textDecoration: 'underline' } },
    {
      label: 'З',
      title: 'Зачёркнутый',
      open: '<s>',
      close: '</s>',
      style: { textDecoration: 'line-through' },
    },
    { label: '</>', title: 'Моноширинный', open: '<code>', close: '</code>' },
    { label: '❝', title: 'Цитата', open: '<blockquote>', close: '</blockquote>' },
    { label: '▒', title: 'Скрытый текст (спойлер)', open: '<tg-spoiler>', close: '</tg-spoiler>' },
  ];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * HTML для предпросмотра. Весь текст экранируется, после чего обратно включаются только
 * разрешённые Telegram теги — постороннюю разметку или скрипт вставить нельзя.
 */
function previewHtml(text: string): string {
  return (
    escape(text)
      // Сущности, которые автор написал сам (&lt; &gt; &amp;), показываем так же, как их покажет Telegram.
      .replace(/&amp;(lt|gt|amp|quot);/g, '&$1;')
      .replace(/&lt;(\/?)(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote)&gt;/g, '<$1$2>')
      .replace(/&lt;tg-spoiler&gt;/g, '<span class="spoiler">')
      .replace(/&lt;\/tg-spoiler&gt;/g, '</span>')
      .replace(
        /&lt;a href="(https?:\/\/[^"<>\s]+)"&gt;/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">',
      )
      .replace(/&lt;\/a&gt;/g, '</a>')
  );
}

const plainLength = (text: string) => text.replace(/<\/?[a-zA-Z][^<>]*>/g, '').length;

const STATUS: Record<BroadcastDto['status'], [tone: string, label: string]> = {
  SENDING: ['tone-warn', 'Отправляется'],
  DONE: ['tone-ok', 'Завершена'],
  CANCELLED: ['tone-mute', 'Остановлена'],
};

export function Broadcast() {
  const toast = useToast();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [media, setMedia] = useState<Media | null>(null);
  const [buttons, setButtons] = useState<BroadcastButton[]>([]);
  const [locale, setLocale] = useState<Locale | ''>('');
  const [uploading, setUploading] = useState<'photo' | 'voice' | null>(null);
  const [confirm, setConfirm] = useState(false);

  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'broadcasts'],
    queryFn: () => api<{ items: BroadcastDto[]; audience: BroadcastAudience }>('/api/admin/broadcasts'),
    // Пока рассылка идёт, прогресс обновляется каждые две секунды.
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === 'SENDING') ? 2000 : false),
  });

  const input: BroadcastInput = {
    text,
    mediaKind: media?.mediaKind ?? null,
    mediaFileId: media?.mediaFileId ?? null,
    buttons: buttons.map((b) => ({ text: b.text.trim(), url: b.url === null ? null : b.url.trim() })),
    locale: locale || null,
  };
  const test = useAction<BroadcastInput>('/api/admin/broadcasts/test', {
    success: 'Отправлено вам в бота — проверьте, как выглядит',
  });
  const send = useAction<BroadcastInput, BroadcastDto>('/api/admin/broadcasts', {
    success: 'Рассылка запущена',
    onDone: () => {
      setConfirm(false);
      setText('');
      setMedia(null);
      setButtons([]);
    },
  });
  const cancel = useAction<{ id: string }>((b) => `/api/admin/broadcasts/${b.id}/cancel`, {
    success: 'Рассылка остановлена',
  });

  if (isPending) return <Skeleton height={420} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const { audience, items } = data;
  const recipients = locale ? audience.byLocale[locale] : audience.total;
  const limit = media ? 1024 : 4096;
  const length = plainLength(text);
  const running = items.some((b) => b.status === 'SENDING');
  const buttonsValid = buttons.every(
    (b) => b.text.trim() && (b.url === null || /^(https:\/\/|tg:\/\/)\S+$/i.test(b.url.trim())),
  );
  const ready = (text.trim() !== '' || media !== null) && length <= limit && buttonsValid;

  /** Оборачивает выделение в теги и возвращает курсор в поле. */
  function wrap(open: string, close: string) {
    const el = area.current;
    if (!el) return;
    const { selectionStart: from, selectionEnd: to } = el;
    const selected = text.slice(from, to);
    setText(text.slice(0, from) + open + selected + close + text.slice(to));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + open.length, from + open.length + selected.length);
    });
  }
  function addLink() {
    const url = window.prompt('Адрес ссылки', 'https://');
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url.trim())) return toast('Ссылка должна начинаться с https://', true);
    wrap(`<a href="${url.trim().replace(/"/g, '%22')}">`, '</a>');
  }

  async function attach(kind: 'photo' | 'voice', file: File | undefined) {
    if (!file) return;
    setUploading(kind);
    try {
      const uploaded = await apiUpload<Omit<Media, 'name'>>(
        `/api/admin/broadcasts/media?kind=${kind}&name=${encodeURIComponent(file.name)}`,
        file,
      );
      setMedia({ ...uploaded, name: file.name });
      toast(kind === 'photo' ? 'Фото загружено' : 'Голосовое загружено');
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setUploading(null);
    }
  }

  return (
    <>
      <PageHead title="Рассылка" />
      <div className="composer">
        <div className="stack">
          <div className="panel">
            <h3>Кому</h3>
            <div className="chips">
              <button className="chip" aria-pressed={locale === ''} onClick={() => setLocale('')}>
                Всем · {audience.total}
              </button>
              {LOCALES.map((l) => (
                <button key={l} className="chip" aria-pressed={locale === l} onClick={() => setLocale(l)}>
                  {LOCALE_LABELS[l]} · {audience.byLocale[l]}
                </button>
              ))}
            </div>
            <p className="muted small">
              Получатели — все, кто нажал /start в боте и не заблокировал его.
              {audience.byLocale.none > 0 &&
                ` Ещё не выбрали язык: ${audience.byLocale.none} — они получают только рассылку «Всем».`}
            </p>
          </div>

          <div className="panel">
            <h3>Сообщение</h3>
            <div className="toolbar">
              {FORMATS.map((f) => (
                <button
                  key={f.title}
                  type="button"
                  title={f.title}
                  aria-label={f.title}
                  style={f.style}
                  onClick={() => wrap(f.open, f.close)}
                >
                  {f.label}
                </button>
              ))}
              <button type="button" title="Ссылка" aria-label="Ссылка" onClick={addLink}>
                🔗
              </button>
            </div>
            <textarea
              ref={area}
              className="input"
              value={text}
              placeholder={
                'Текст сообщения.\n\nПереносы строк сохраняются как есть. Выделите текст и нажмите кнопку форматирования.'
              }
              onChange={(e) => setText(e.target.value)}
            />
            <div className="row between small">
              <span className="muted">Знаки &lt; и &gt; в тексте пишите как &amp;lt; и &amp;gt;</span>
              <span className="mono" style={{ color: length > limit ? 'var(--danger)' : 'var(--text-3)' }}>
                {length} / {limit}
              </span>
            </div>
          </div>

          <div className="panel">
            <h3>Вложение</h3>
            {media ? (
              <div className="attachment">
                <Icon name={media.mediaKind === 'photo' ? 'inbox' : 'chat'} size={18} />
                <span className="grow truncate">
                  {media.mediaKind === 'photo' ? 'Фото' : 'Голосовое'}: {media.name}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label="Убрать вложение"
                  onClick={() => setMedia(null)}
                />
              </div>
            ) : (
              <div className="row wrap">
                {(
                  [
                    ['photo', 'Прикрепить фото', 'image/jpeg,image/png,image/webp'],
                    ['voice', 'Прикрепить голосовое', '.ogg,.oga,.mp3,.m4a,audio/*'],
                  ] as const
                ).map(([kind, label, accept]) => (
                  <label
                    key={kind}
                    className={`btn secondary sm ${uploading ? 'disabled' : ''}`}
                    style={{ cursor: 'pointer' }}
                  >
                    {uploading === kind ? <span className="spinner" /> : <Icon name="plus" size={16} />}
                    {label}
                    <input
                      type="file"
                      accept={accept}
                      hidden
                      disabled={uploading !== null}
                      onChange={(e) => {
                        void attach(kind, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
            <p className="muted small">
              Одно вложение на сообщение: фото (до 10 МБ) или голосовое (.ogg, .mp3, .m4a). Файл загружается
              через ваш чат с ботом — он появится там. С вложением текст становится подписью, до 1024
              символов.
            </p>
          </div>

          <div className="panel">
            <h3>Кнопки под сообщением</h3>
            {buttons.map((b, i) => (
              <div className="button-row" key={i}>
                <input
                  className="input"
                  value={b.text}
                  maxLength={40}
                  placeholder="Текст кнопки"
                  onChange={(e) =>
                    setButtons(buttons.map((x, n) => (n === i ? { ...x, text: e.target.value } : x)))
                  }
                />
                {b.url === null ? (
                  <span className="muted small">Открывает мини-приложение</span>
                ) : (
                  <input
                    className="input"
                    value={b.url}
                    maxLength={500}
                    placeholder="https://"
                    onChange={(e) =>
                      setButtons(buttons.map((x, n) => (n === i ? { ...x, url: e.target.value } : x)))
                    }
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label="Удалить кнопку"
                  onClick={() => setButtons(buttons.filter((_, n) => n !== i))}
                />
              </div>
            ))}
            <div className="row wrap">
              <Button
                size="sm"
                icon="link"
                disabled={buttons.length >= 8}
                onClick={() => setButtons([...buttons, { text: '', url: 'https://' }])}
              >
                Кнопка-ссылка
              </Button>
              <Button
                size="sm"
                icon="wheel"
                disabled={buttons.length >= 8}
                onClick={() => setButtons([...buttons, { text: 'Открыть приложение', url: null }])}
              >
                Кнопка «Открыть приложение»
              </Button>
            </div>
            {!buttonsValid && (
              <p className="small" style={{ color: 'var(--danger)' }}>
                У каждой кнопки должен быть текст и ссылка, начинающаяся с https://
              </p>
            )}
          </div>

          <div className="row wrap">
            <Button loading={test.isPending} disabled={!ready} onClick={() => test.mutate(input)}>
              Отправить себе
            </Button>
            <Button
              variant="primary"
              disabled={!ready || running || recipients === 0}
              onClick={() => setConfirm(true)}
            >
              Разослать · {recipients}
            </Button>
            {running && <span className="muted small">Дождитесь завершения текущей рассылки</span>}
          </div>
        </div>

        <div className="tg-preview">
          <div className="tiny" style={{ marginBottom: 10 }}>
            Предпросмотр
          </div>
          <div className="tg-bubble">
            {media && (
              <div className="media">
                <Icon name={media.mediaKind === 'photo' ? 'inbox' : 'chat'} size={28} />
                {media.mediaKind === 'photo' ? 'Фото' : 'Голосовое сообщение'}
              </div>
            )}
            {/* Текст экранирован, включены только разрешённые теги — см. previewHtml */}
            <div
              className="body"
              dangerouslySetInnerHTML={{
                __html: previewHtml(text) || '<span style="opacity:.5">Текст сообщения</span>',
              }}
            />
          </div>
          {buttons.length > 0 && (
            <div className="tg-buttons">
              {buttons.map((b, i) => (
                <span key={i}>{b.text || 'Кнопка'}</span>
              ))}
            </div>
          )}
          <p className="muted small" style={{ marginTop: 12 }}>
            Точный вид покажет «Отправить себе» — сообщение придёт вам в бота.
          </p>
        </div>
      </div>

      <div className="group-title">История рассылок</div>
      {items.length === 0 ? (
        <State icon="chat" title="Рассылок ещё не было" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Сообщение</th>
                <th>Кому</th>
                <th>Статус</th>
                <th>Доставлено</th>
                <th>Автор</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td className="muted">{dateTime(b.createdAt)}</td>
                  <td className="wrap">
                    {b.mediaKind && <b>{b.mediaKind === 'photo' ? '[фото] ' : '[голосовое] '}</b>}
                    {b.text.replace(/<[^>]+>/g, '').slice(0, 120) || (
                      <span className="muted">без текста</span>
                    )}
                  </td>
                  <td>{b.locale ? LOCALE_LABELS[b.locale] : 'Всем'}</td>
                  <td>
                    <Badge tone={STATUS[b.status][0]}>{STATUS[b.status][1]}</Badge>
                  </td>
                  <td>
                    <div className="row">
                      <div className="progress">
                        <i style={{ width: `${b.total ? ((b.sent + b.failed) / b.total) * 100 : 0}%` }} />
                      </div>
                      <span className="mono small">
                        {b.sent} из {b.total}
                        {b.failed > 0 && <span className="muted"> · не дошло {b.failed}</span>}
                      </span>
                    </div>
                  </td>
                  <td className="muted">{b.createdBy ?? '—'}</td>
                  <td>
                    {b.status === 'SENDING' && (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={cancel.isPending}
                        onClick={() => cancel.mutate({ id: b.id })}
                      >
                        Остановить
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Запустить рассылку?">
        <div className="stack" style={{ marginTop: 12 }}>
          <p>
            Сообщение получат <b>{recipients}</b>{' '}
            {locale ? `подписчиков с языком «${LOCALE_LABELS[locale]}»` : 'подписчиков бота'}. Отправленные
            сообщения отозвать нельзя.
          </p>
          <p className="muted small">
            Если ещё не проверяли — нажмите «Отправить себе» и посмотрите, как сообщение выглядит в Telegram.
          </p>
          <div className="row">
            <Button className="grow" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              className="grow"
              variant="primary"
              loading={send.isPending}
              onClick={() => send.mutate(input)}
            >
              Разослать
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
