// /scrobble: the manual scrobble form and its publication states (M7.2.2;
// ADR 0004 §5.2).
//
// - Validation is @atmusic/core's `buildScrobbleRecord` (the Rust scrobble
//   rules: 1–256 scalars and ≤1,024 UTF-8 bytes after White_Space trimming,
//   listenedAt ≥ 1970 and ≤ now + 300 s, duration 1–86,400, UUID MBID). The
//   form reports an error for every invalid field and creates no outbox row
//   while any field is invalid.
// - A valid submission is persisted by the outbox (TID rkey allocated once)
//   before any request; the status line then follows the row: queued →
//   published → indexed, or excluded (reason) / failed (code). Nothing is
//   shown as success before the index has verified the record.
// - Publishing needs a session and a deployment with publication; otherwise
//   the form is not shown.

import type { Clock } from '@atmusic/core/deps';
import { buildScrobbleRecord, MSG_DURATION } from '@atmusic/core/scrobble';
import { useRef, useState } from 'preact/hooks';
import { OperationStatus } from '../components/operation-status';
import type { OutboxService } from '../components/outbox-service';
import { useServices } from '../components/services';
import { useSessionHandle } from '../components/session-identity';
import { ErrorState, LoadingState, PublishingUnavailable, SignInPrompt } from '../components/state-views';
import { useOutbox, useOutboxOps } from '../components/use-outbox';
import type { OutboxOperation } from '../outbox/store';

export type FieldName = 'artist' | 'track' | 'album' | 'listenedAt' | 'durationSeconds' | 'recordingMbid';

export type FormValues = Record<FieldName, string>;

export type FieldErrors = Partial<Record<FieldName | 'form', string>>;

const FIELDS: readonly { name: FieldName; label: string; required: boolean; hint?: string }[] = [
  { name: 'artist', label: 'Artist', required: true },
  { name: 'track', label: 'Track', required: true },
  { name: 'album', label: 'Album (optional)', required: false },
  {
    name: 'listenedAt',
    label: 'Listened at (UTC)',
    required: true,
    hint: 'An RFC 3339 UTC time such as 2026-01-15T11:58:00Z, at most 5 minutes in the future.',
  },
  { name: 'durationSeconds', label: 'Duration in seconds (optional)', required: false, hint: 'From 1 to 86400.' },
  {
    name: 'recordingMbid',
    label: 'MusicBrainz recording ID (optional)',
    required: false,
    hint: 'A UUID such as 13f12616-51d7-4023-a70b-a288ced4693a.',
  },
];

const REQUIRED_TEXT: Partial<Record<FieldName, string>> = {
  artist: 'Enter the artist.',
  track: 'Enter the track.',
  listenedAt: 'Enter when you listened.',
};

function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function emptyForm(clock: Clock): FormValues {
  return {
    artist: '',
    track: '',
    album: '',
    listenedAt: isoSeconds(clock.nowMs()),
    durationSeconds: '',
    recordingMbid: '',
  };
}

/** The input object the core builder takes: empty optional fields are omitted. */
export function formInput(values: FormValues): { input: Record<string, unknown>; errors: FieldErrors } {
  const input: Record<string, unknown> = {
    artist: values.artist,
    track: values.track,
    listenedAt: values.listenedAt.trim(),
  };
  const errors: FieldErrors = {};
  if (values.album !== '') input.album = values.album;
  if (values.recordingMbid.trim() !== '') input.recordingMbid = values.recordingMbid.trim();
  const duration = values.durationSeconds.trim();
  if (duration !== '') {
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(duration)) input.durationSeconds = Number(duration);
    else errors.durationSeconds = MSG_DURATION;
  }
  return { input, errors };
}

/**
 * Every field error, using only the core rules: the builder reports the first
 * invalid field; that field is then replaced by a valid stand-in (or dropped
 * when optional) and the rest is checked again.
 */
export function validateForm(values: FormValues, prefix: string, clock: Clock): FieldErrors {
  const { input, errors } = formInput(values);
  for (const field of FIELDS) {
    if (field.required && values[field.name].trim() === '') errors[field.name] = REQUIRED_TEXT[field.name];
  }
  const probe: Record<string, unknown> = { ...input };
  const standIn: Partial<Record<FieldName, unknown>> = {
    artist: 'x',
    track: 'x',
    listenedAt: isoSeconds(clock.nowMs()),
  };
  for (const name of Object.keys(errors) as FieldName[]) {
    if (name in standIn) probe[name] = standIn[name];
    else delete probe[name];
  }
  for (let i = 0; i < FIELDS.length + 1; i++) {
    const built = buildScrobbleRecord(probe, prefix, clock);
    if (built.ok) break;
    const field = built.reason.field as FieldName;
    if (!FIELDS.some((f) => f.name === field) || errors[field] !== undefined) {
      errors.form = `${built.reason.field}: ${built.reason.message}`;
      break;
    }
    errors[field] = built.reason.message;
    if (field in standIn) probe[field] = standIn[field];
    else delete probe[field];
  }
  return errors;
}

export default function ScrobbleScreen() {
  useSessionHandle();
  const outboxState = useOutbox();
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Add a scrobble</h1>
      {outboxState.status === 'anonymous' ? <SignInPrompt>Sign in to publish scrobbles.</SignInPrompt> : null}
      {outboxState.status === 'unavailable' ? <PublishingUnavailable /> : null}
      {outboxState.status === 'loading' ? <LoadingState label="Opening your outbox…" /> : null}
      {outboxState.status === 'error' ? (
        <ErrorState title="Your outbox could not be opened." error={outboxState.error} />
      ) : null}
      {outboxState.status === 'ready' ? <ScrobbleForm outbox={outboxState.outbox} /> : null}
    </section>
  );
}

function ScrobbleForm({ outbox }: { outbox: OutboxService }) {
  const services = useServices();
  const [values, setValuesState] = useState<FormValues>(() => emptyForm(services.clock));
  // The latest input, updated synchronously: a submit right after typing must
  // validate what is in the fields, not the last rendered state.
  const valuesRef = useRef(values);
  const setValues = (next: FormValues) => {
    valuesRef.current = next;
    setValuesState(next);
  };
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const ops = useOutboxOps(outbox);
  const formRef = useRef<HTMLFormElement>(null);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (submitting) return;
    const current = valuesRef.current;
    const found = validateForm(current, outbox.prefix, services.clock);
    setErrors(found);
    const first = FIELDS.find((f) => found[f.name] !== undefined);
    if (first !== undefined || found.form !== undefined) {
      if (first) formRef.current?.querySelector<HTMLInputElement>(`[name="${first.name}"]`)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const result = await outbox.scrobble(formInput(current).input);
      if (!result.ok) {
        setErrors({ [result.reason.field]: result.reason.message });
        return;
      }
      setSubmitted((ids) => [result.op.id, ...ids]);
      setValues(emptyForm(services.clock));
    } catch {
      setErrors({ form: 'Your scrobble could not be saved in this browser. Nothing was sent.' });
    } finally {
      setSubmitting(false);
    }
  };

  const shown: OutboxOperation[] =
    ops === null ? [] : submitted.flatMap((id) => ops.filter((op) => op.id === id && op.kind === 'scrobble_create'));

  return (
    <>
      <p>
        A scrobble is published as a public record in your own repository on your PDS. Anyone can read it, and this
        AppView indexes it once it has verified the signed record.
      </p>
      <form ref={formRef} noValidate onSubmit={onSubmit} aria-describedby={errors.form ? 'form-error' : undefined}>
        {FIELDS.map((field) => {
          const error = errors[field.name];
          const hintId = field.hint ? `${field.name}-hint` : undefined;
          const errorId = error ? `${field.name}-error` : undefined;
          return (
            <div class="field" key={field.name}>
              <label for={`field-${field.name}`}>{field.label}</label>
              <input
                id={`field-${field.name}`}
                name={field.name}
                type="text"
                inputMode={field.name === 'durationSeconds' ? 'numeric' : undefined}
                required={field.required}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
                value={values[field.name]}
                onInput={(e) => {
                  const value = (e.currentTarget as HTMLInputElement).value;
                  setValues({ ...valuesRef.current, [field.name]: value });
                }}
              />
              {field.hint ? (
                <span class="field-hint" id={hintId}>
                  {field.hint}
                </span>
              ) : null}
              {error ? (
                <span class="field-error" id={errorId} data-field-error={field.name}>
                  {error}
                </span>
              ) : null}
            </div>
          );
        })}
        {errors.form ? (
          <p class="field-error" id="form-error" role="alert">
            {errors.form}
          </p>
        ) : null}
        <button type="submit" disabled={submitting}>
          Publish scrobble
        </button>
      </form>
      {shown.length > 0 ? (
        <section aria-labelledby="submitted-title">
          <h2 id="submitted-title">Your submissions</h2>
          <ul class="scrobble-list" aria-live="polite">
            {shown.map((op) => (
              <li key={op.id} data-op-id={op.id}>
                <span class="track">{String(op.record?.track ?? '')}</span>
                {' by '}
                <span class="artist">{String(op.record?.artist ?? '')}</span> <OperationStatus op={op} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
