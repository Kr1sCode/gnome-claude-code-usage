import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Same OAuth surface Claude Code's CLI itself uses (see the "Minimal" sibling
// extension for where this was sourced from).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA_HEADER = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const POLL_SECONDS = 120;
const MIN_REFRESH_MS = 30 * 1000;

// A small icon on every row, so each bar reads as "Claude Code" at a glance
// even without the header above it.
const ROW_ICON = 'utilities-terminal-symbolic';
// Fixed on purpose — see the note by set_width() below for why this can't be
// dynamic/expand-to-fill without risking runaway growth. Sized for two of
// these sitting side by side in one row rather than one per row.
const TRACK_WIDTH = 72;
const BAR_HEIGHT = 6;
const COLOR_OK = '#3584e4';
const COLOR_WARN = '#ff7800';
const COLOR_CRIT = '#e01b24';

function levelColor(percent, severity) {
    if (severity === 'critical' || percent >= 90)
        return COLOR_CRIT;
    if (severity === 'warning' || percent >= 75)
        return COLOR_WARN;
    return COLOR_OK;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

function readCredentials() {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(credentialsPath());
        file.load_contents_async(null, (f, res) => {
            try {
                const [ok, data] = f.load_contents_finish(res);
                if (!ok) {
                    resolve(null);
                    return;
                }
                const root = JSON.parse(decoder.decode(data));
                resolve(root?.claudeAiOauth?.accessToken ? root : null);
            } catch {
                resolve(null);
            }
        });
    });
}

function writeCredentials(root) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(credentialsPath());
        const data = encoder.encode(JSON.stringify(root, null, 2));
        file.replace_contents_bytes_async(
            new GLib.Bytes(data), null, false,
            Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

class UsageError extends Error {
    constructor(message, status = 0, retryAfterSeconds = 0) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

class SignedOutError extends UsageError {
    constructor() {
        super('Brak zalogowania Claude Code (~/.claude/.credentials.json)', 401);
        this.name = 'SignedOutError';
    }
}

class UsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 15;
        this._tokenPromise = null;
    }

    _request(method, url, {token, jsonBody} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            const headers = msg.get_request_headers();
            headers.append('anthropic-beta', BETA_HEADER);
            headers.append('anthropic-version', API_VERSION);
            headers.append('Accept', 'application/json');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);
            if (jsonBody !== undefined) {
                const raw = encoder.encode(JSON.stringify(jsonBody));
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
            }
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        const retryAfter = Number(msg.get_response_headers().get_one('Retry-After')) || 0;
                        reject(new UsageError(`HTTP ${status} z ${url}`, status, retryAfter));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _refreshToken(root) {
        const oauth = root.claudeAiOauth;
        let data;
        try {
            data = await this._request('POST', TOKEN_URL, {
                jsonBody: {grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID},
            });
        } catch (e) {
            // Duck-typed on .status rather than `instanceof UsageError`: GNOME's
            // extension loader can end up with two live copies of this module
            // (old instance tearing down, new one starting), and errors thrown
            // by one don't pass instanceof checks against the other's class.
            if (e?.status === 400 || e?.status === 401)
                throw new UsageError('Sesja wygasła — zaloguj się ponownie w Claude Code', 401);
            throw e;
        }
        if (!data.access_token)
            throw new UsageError('Brak access_token w odpowiedzi odświeżania');
        oauth.accessToken = data.access_token;
        if (data.refresh_token)
            oauth.refreshToken = data.refresh_token;
        if (data.expires_in)
            oauth.expiresAt = Date.now() + data.expires_in * 1000;
        await writeCredentials(root);
        return oauth.accessToken;
    }

    _validToken() {
        if (!this._tokenPromise) {
            this._tokenPromise = this._resolveToken()
                .finally(() => (this._tokenPromise = null));
        }
        return this._tokenPromise;
    }

    async _resolveToken() {
        const root = await readCredentials();
        if (!root)
            throw new SignedOutError();
        const oauth = root.claudeAiOauth;
        const expiresAt = Number(oauth.expiresAt) || 0;
        if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
            return oauth.accessToken;
        return this._refreshToken(root);
    }

    async fetchUsage() {
        const token = await this._validToken();
        return this._request('GET', USAGE_URL, {token});
    }
}

// Picks the session (5h) and weekly-all (7d) windows out of the API's
// self-describing limits[] array. Scoped per-model windows are ignored here;
// this tile only has room for the two headline numbers.
function windowsByKind(usage) {
    const limits = Array.isArray(usage?.limits) ? usage.limits : [];
    const out = {session: null, weekly_all: null};
    for (const l of limits) {
        if (l?.percent == null || !Number.isFinite(Number(l.percent)))
            continue;
        if (l.kind === 'session' || l.kind === 'weekly_all')
            out[l.kind] = {percent: Number(l.percent), severity: l.severity ?? 'normal'};
    }
    return out;
}

const UsageBarRow = GObject.registerClass(
class UsageBarRow extends St.BoxLayout {
    _init(label) {
        super._init({
            style: 'spacing: 8px; padding: 4px 6px;',
            y_align: Clutter.ActorAlign.CENTER,
            // Splits the shared outer row evenly with its sibling segment —
            // safe here because it only expands *this segment's* box, never
            // feeding back into the fixed-width track inside it.
            x_expand: true,
        });

        this._icon = new St.Icon({
            icon_name: ROW_ICON,
            style: 'icon-size: 14px; color: rgba(255,255,255,0.65);',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        this._name = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name.set_width(28);
        this.add_child(this._name);

        // A classic filled/unfilled progress bar instead of a slider-style
        // groove: track paints the "empty" part, fill (packed flush-left)
        // paints the "used" part — so the proportion is unambiguous even at
        // a glance, unlike BarLevel's thin accent sliver on a full-width
        // track (see commit history for why that was swapped out).
        //
        // The track's width is set with set_width() — a hard Clutter size
        // override, not x_expand/CSS — and is NEVER recomputed from live
        // layout. An earlier version stretched the track with x_expand and
        // resized the fill off the track's *reported* width on every
        // notify::width; because the track (a BoxLayout) also derives its
        // own preferred width from its children, that fed back on itself —
        // stable most of the time, but a stage-wide relayout (e.g. resuming
        // from suspend) kicked it into runaway growth. A fixed width breaks
        // the cycle outright: nothing here can ever influence the track's
        // own size again.
        this._track = new St.BoxLayout({
            style: `height: ${BAR_HEIGHT}px; border-radius: ${BAR_HEIGHT / 2}px; background-color: rgba(255,255,255,0.15);`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._track.set_width(TRACK_WIDTH);
        this._fill = new St.Widget({
            style: `height: ${BAR_HEIGHT}px; border-radius: ${BAR_HEIGHT / 2}px; background-color: ${COLOR_OK};`,
        });
        this._track.add_child(this._fill);
        this.add_child(this._track);

        this._pct = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        this._pct.set_width(40);
        this.add_child(this._pct);
    }

    setValue(percent, text, color = COLOR_OK) {
        const fraction = Math.max(0, Math.min(100, percent)) / 100;
        this._fill.set_width(Math.round(fraction * TRACK_WIDTH));
        this._fill.style = `height: ${BAR_HEIGHT}px; border-radius: ${BAR_HEIGHT / 2}px; background-color: ${color};`;
        this._pct.text = text;
    }
});

export default class ClaudeUsageBarsExtension extends Extension {
    enable() {
        this._client = new UsageClient();
        // A native-styled section divider with a small muted label, so the
        // two bars below are clearly marked as Claude Code's — without a
        // header the pair reads as an unlabeled generic gauge.
        this._header = new PopupMenu.PopupSeparatorMenuItem('Claude Code');
        this._sessionRow = new UsageBarRow('5h');
        this._weeklyRow = new UsageBarRow('7d');
        // Both segments share one outer row so they sit side by side on a
        // single line instead of stacking; x_expand on each segment (see
        // UsageBarRow) splits this row's width evenly between them.
        this._combinedRow = new St.BoxLayout({style: 'spacing: 4px;'});
        this._combinedRow.add_child(this._sessionRow);
        this._combinedRow.add_child(this._weeklyRow);

        // addItem() appends to the end of the quick-settings grid, after
        // everything else (background apps included) — so this always lands
        // at the bottom, unlike addExternalIndicator() which inserts higher up.
        this._menu = Main.panel.statusArea.quickSettings.menu;
        this._menu.addItem(this._header, 2);
        this._menu.addItem(this._combinedRow, 2);

        this._busy = false;
        this._lastFetchMs = 0;
        this._hasData = false;
        this._backoffUntilMs = 0;
        this._consecutive429 = 0;
        this._openStateId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        });

        this._refresh(true);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh(force = false) {
        if (this._busy)
            return;
        // Even a "force" refresh (menu opened, manual poll tick) must respect
        // an active 429 backoff — retrying sooner is exactly what got us
        // rate-limited in the first place.
        if (Date.now() < this._backoffUntilMs)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();
        this._client.fetchUsage()
            .then(usage => this._render(usage))
            .catch(e => this._renderError(e))
            .finally(() => (this._busy = false));
    }

    _render(usage) {
        const {session, weekly_all: weekly} = windowsByKind(usage);
        if (session)
            this._sessionRow.setValue(session.percent, `${Math.round(session.percent)}%`, levelColor(session.percent, session.severity));
        else
            this._sessionRow.setValue(0, '—');
        if (weekly)
            this._weeklyRow.setValue(weekly.percent, `${Math.round(weekly.percent)}%`, levelColor(weekly.percent, weekly.severity));
        else
            this._weeklyRow.setValue(0, '—');
        this._hasData = true;
        this._consecutive429 = 0;
        this._backoffUntilMs = 0;
    }

    _renderError(e) {
        if (e?.status === 429) {
            // Respect the server's own Retry-After when it sends one;
            // otherwise back off exponentially (30s, 60s, 120s, ... capped at
            // 10min) so repeated polling can't keep re-triggering the limit.
            this._consecutive429 += 1;
            const backoffSeconds = e.retryAfterSeconds > 0
                ? e.retryAfterSeconds
                : Math.min(600, 30 * 2 ** (this._consecutive429 - 1));
            this._backoffUntilMs = Date.now() + backoffSeconds * 1000;
            // Transient — if we already have real numbers on screen, keep
            // showing them instead of blanking to "błąd" on every rate-limited poll.
            if (this._hasData) {
                logError(e, `claude-usage-bars: rate limited, backing off ${backoffSeconds}s, keeping last values`);
                return;
            }
            logError(e, `claude-usage-bars: rate limited, backing off ${backoffSeconds}s`);
        } else {
            logError(e, 'claude-usage-bars: refresh failed');
        }
        const text = e?.name === 'SignedOutError' ? 'brak' : 'błąd';
        this._sessionRow.setValue(0, text);
        this._weeklyRow.setValue(0, text);
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._openStateId) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = null;
        }
        this._menu = null;
        this._header?.destroy();
        // Destroying the combined row cascades to its two segment children —
        // destroying them separately too would double-destroy.
        this._combinedRow?.destroy();
        this._header = null;
        this._combinedRow = null;
        this._sessionRow = null;
        this._weeklyRow = null;
        this._client = null;
    }
}
