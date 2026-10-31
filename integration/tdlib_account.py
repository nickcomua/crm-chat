#!/usr/bin/env python3
"""Copy one saved desktop TDLib account and answer login-test commands.

The web integration test uses this to read a phone number, read a login code
from the Telegram service chat, and temporarily set a cloud password. Stdout is
status only. The phone number and the login code are written to
CRM_CHAT_SECRET_FILE (mode 0600). The cloud password is read from
CRM_CHAT_CLOUD_PASSWORD and is never printed. The saved directory is not
modified. This process never calls logOut.
"""
import glob
import json
import os
import re
import select
import shutil
import signal
import sys
import tempfile
import time

SERVICE_USER_ID = 777000
PASSWORD_HINT = 'crm-chat'


def login_code(text):
    """Return the 5-digit login code from a service message, or None."""
    if not isinstance(text, str) or text == '':
        return None
    labeled = re.search(
        r'(?:code|код)[^\d]{0,24}(\d{5})(?!\d)',
        text,
        re.IGNORECASE,
    )
    if labeled is not None:
        return labeled.group(1)
    bare = re.search(r'(?<!\d)(\d{5})(?!\d)', text)
    if bare is not None:
        return bare.group(1)
    return None


def self_check():
    cases = (
        ('Login code: 12345. Do not give this code to anyone.', '12345'),
        ('Код для входу в Telegram: 54321', '54321'),
        ('Код для входа в Telegram: 11111', '11111'),
        ('12345 is your code', '12345'),
        ('no digits here', None),
        ('call 1234567', None),
    )
    for text, expected in cases:
        if login_code(text) != expected:
            raise SystemExit('tdlib_account: self-check failed')
    print('tdlib_account: self-check pass')


def public_error(message):
    text = '' if message is None else str(message)
    text = re.sub(r'\+\d{6,15}', '+[redacted]', text)
    text = re.sub(r'(?<!\d)\d{8,15}(?!\d)', '[redacted]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+', '[redacted-email]', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:200]


if len(sys.argv) >= 2 and sys.argv[1] == 'self-check':
    self_check()
    sys.exit(0)

if len(sys.argv) != 2 or sys.argv[1] not in ('1', '2'):
    print('tdlib_account: usage: tdlib_account.py <slot 1|2> | self-check', file=sys.stderr)
    sys.exit(1)

slot = int(sys.argv[1])
secret_path = os.environ.get('CRM_CHAT_SECRET_FILE', '')
if secret_path == '':
    print(f'slot-{slot}: error secret-file', flush=True)
    sys.exit(1)

import ctypes  # noqa: E402

lib_path = os.environ.get('CRM_CHAT_TDLIB_JSON', '')
if lib_path == '':
    matches = sorted(glob.glob('/nix/store/*-tdlib-1.8.69/lib/libtdjson.so'))
    lib_path = matches[0] if matches else ''
if lib_path == '' or not os.path.exists(lib_path):
    print(f'slot-{slot}: error tdjson', flush=True)
    sys.exit(1)

lib = ctypes.CDLL(lib_path)
lib.td_create_client_id.restype = ctypes.c_int
lib.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
lib.td_receive.argtypes = [ctypes.c_double]
lib.td_receive.restype = ctypes.c_char_p
lib.td_execute.argtypes = [ctypes.c_char_p]
lib.td_execute.restype = ctypes.c_char_p
lib.td_execute(json.dumps({'@type': 'setLogVerbosityLevel', 'new_verbosity_level': 0}).encode())
lib.td_execute(json.dumps({'@type': 'setLogStream', 'log_stream': {'@type': 'logStreamEmpty'}}).encode())

base = os.path.expanduser(
    os.environ.get('CRM_CHAT_TDLIB_DIR', '~/.local/share/app.crmchat.desktop/tdlib'),
)
if not os.path.isdir(base):
    print(f'slot-{slot}: NOT AUTHORIZED (missing)', flush=True)
    sys.exit(2)
dirs = sorted(os.listdir(base))
if slot < 1 or slot > len(dirs):
    print(f'slot-{slot}: NOT AUTHORIZED (missing)', flush=True)
    sys.exit(2)

tmp = tempfile.mkdtemp(prefix='tdlib-account-')
db = os.path.join(tmp, 'db')
source = os.path.join(base, dirs[slot - 1])
if not os.path.isdir(source):
    shutil.rmtree(tmp, ignore_errors=True)
    say_missing = f'slot-{slot}: NOT AUTHORIZED (missing)'
    print(say_missing, flush=True)
    sys.exit(2)
norm_source = os.path.realpath(source)
norm_db = os.path.realpath(db)
if norm_db == norm_source or norm_db.startswith(norm_source + os.sep) or norm_source.startswith(norm_db + os.sep):
    shutil.rmtree(tmp, ignore_errors=True)
    print(f'slot-{slot}: error copy', flush=True)
    sys.exit(1)
shutil.copytree(source, db)

cid = lib.td_create_client_id()
extra_n = 0
responses = {}
service_chat_id = None
baseline_id = 0
newest_code = None
newest_code_id = 0
armed = False
stop = False
closed = False
secret = {}


def say(line):
    try:
        print(f'slot-{slot}: {line}', flush=True)
    except BrokenPipeError:
        pass


def publish():
    payload = json.dumps(secret).encode()
    temporary = secret_path + '.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, secret_path)
    os.chmod(secret_path, 0o600)


def wipe_secret():
    secret.clear()
    try:
        publish()
    except OSError:
        pass


def send(query):
    global extra_n
    extra_n += 1
    extra = f'q{extra_n}'
    body = dict(query)
    body['@extra'] = extra
    lib.td_send(cid, json.dumps(body).encode())
    return extra


def message_text(message):
    content = message.get('content') or {}
    if content.get('@type') != 'messageText':
        return ''
    text = content.get('text') or {}
    if isinstance(text, dict):
        return text.get('text') or ''
    if isinstance(text, str):
        return text
    return ''


def consider_message(message):
    global newest_code, newest_code_id
    if not isinstance(message, dict):
        return
    if service_chat_id is not None and str(message.get('chat_id')) != str(service_chat_id):
        return
    sender = message.get('sender_id') or {}
    if sender.get('@type') != 'messageSenderUser' or sender.get('user_id') != SERVICE_USER_ID:
        return
    message_id = message.get('id') or 0
    try:
        message_id = int(message_id)
    except (TypeError, ValueError):
        return
    if message_id <= baseline_id:
        return
    code = login_code(message_text(message))
    if code is None:
        return
    if message_id >= newest_code_id:
        newest_code = code
        newest_code_id = message_id


def handle(message):
    if message.get('@client_id') not in (None, cid):
        return
    extra = message.get('@extra')
    if extra is not None:
        responses[extra] = message
    if message.get('@type') == 'updateNewMessage':
        consider_message(message.get('message') or {})


def wait_extra(extra, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if extra in responses:
            return responses.pop(extra)
        if stop:
            raise TimeoutError('stopped')
        raw = lib.td_receive(0.4)
        if not raw:
            continue
        try:
            handle(json.loads(raw))
        except json.JSONDecodeError:
            continue
    raise TimeoutError('timeout')


def read_command(timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if stop:
            return 'quit'
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if ready:
            line = sys.stdin.readline()
            if line == '':
                return 'quit'
            command = line.strip()
            if command != '':
                return command
        raw = lib.td_receive(0.3)
        if not raw:
            continue
        try:
            handle(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return None


def authorize():
    send({'@type': 'getOption', 'name': 'version'})
    deadline = time.time() + 40
    while time.time() < deadline:
        raw = lib.td_receive(1.0)
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if message.get('@client_id') not in (None, cid):
            continue
        if message.get('@type') == 'error':
            continue
        if message.get('@type') != 'updateAuthorizationState':
            handle(message)
            continue
        state = message['authorization_state']['@type']
        if state == 'authorizationStateWaitTdlibParameters':
            send({
                '@type': 'setTdlibParameters',
                'use_test_dc': False,
                'database_directory': db,
                'files_directory': os.path.join(db, 'files'),
                'database_encryption_key': '',
                'use_file_database': True,
                'use_chat_info_database': True,
                'use_message_database': True,
                'use_secret_chats': False,
                'api_id': int(os.environ['TG_ID']),
                'api_hash': os.environ['TG_HASH'],
                'system_language_code': 'en',
                'device_model': 'crm-chat validation',
                'system_version': 'Linux',
                'application_version': '0.1',
            })
        elif state == 'authorizationStateReady':
            return
        elif state in (
            'authorizationStateWaitPhoneNumber',
            'authorizationStateWaitCode',
            'authorizationStateWaitOtherDeviceConfirmation',
            'authorizationStateWaitPassword',
            'authorizationStateClosed',
        ):
            say(f'NOT AUTHORIZED ({state})')
            sys.exit(2)
    say('error timeout')
    sys.exit(1)


def remember_phone():
    response = wait_extra(send({'@type': 'getMe'}), 30)
    if response.get('@type') != 'user':
        say('error phone')
        sys.exit(1)
    digits = re.sub(r'\D', '', str(response.get('phone_number') or ''))
    if len(digits) < 8 or len(digits) > 15:
        say('error phone')
        sys.exit(1)
    secret['phone'] = f'+{digits}'
    publish()


def open_service_chat():
    global service_chat_id, baseline_id
    response = wait_extra(send({
        '@type': 'createPrivateChat',
        'user_id': SERVICE_USER_ID,
        'force': False,
    }), 30)
    if response.get('@type') != 'chat':
        say('error service-chat')
        sys.exit(1)
    service_chat_id = response.get('id')
    refresh_baseline()


def refresh_baseline():
    global baseline_id, newest_code, newest_code_id
    response = wait_extra(send({
        '@type': 'getChatHistory',
        'chat_id': service_chat_id,
        'from_message_id': 0,
        'offset': 0,
        'limit': 20,
        'only_local': False,
    }), 30)
    newest = baseline_id
    messages = response.get('messages') or []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            try:
                message_id = int(message.get('id') or 0)
            except (TypeError, ValueError):
                continue
            if message_id > newest:
                newest = message_id
    baseline_id = newest
    newest_code = None
    newest_code_id = 0


def wait_for_code(timeout):
    deadline = time.time() + timeout
    next_history = time.time() + 2
    while time.time() < deadline:
        if newest_code is not None:
            return newest_code
        if stop:
            raise TimeoutError('stopped')
        raw = lib.td_receive(0.4)
        if raw:
            try:
                handle(json.loads(raw))
            except json.JSONDecodeError:
                pass
            if newest_code is not None:
                return newest_code
        if time.time() < next_history:
            continue
        next_history = time.time() + 2
        try:
            response = wait_extra(send({
                '@type': 'getChatHistory',
                'chat_id': service_chat_id,
                'from_message_id': 0,
                'offset': 0,
                'limit': 5,
                'only_local': False,
            }), 8)
        except TimeoutError:
            continue
        for message in response.get('messages') or []:
            consider_message(message)
    if newest_code is not None:
        return newest_code
    raise TimeoutError('timeout')


def read_password_state():
    response = wait_extra(send({'@type': 'getPasswordState'}), 30)
    if response.get('@type') != 'passwordState':
        return None
    return response


def cloud_password():
    return os.environ.get('CRM_CHAT_CLOUD_PASSWORD', '')


def clear_password():
    global armed
    password = cloud_password()
    if len(password) < 8:
        return None
    response = wait_extra(send({
        '@type': 'setPassword',
        'old_password': password,
        'new_password': '',
        'new_hint': '',
        'set_recovery_email_address': False,
        'new_recovery_email_address': '',
    }), 40)
    if response.get('@type') == 'error':
        state = read_password_state()
        return state
    state = read_password_state()
    if state is None and response.get('@type') == 'passwordState':
        return response
    if state is not None and not state.get('has_password'):
        armed = False
    return state


def announce_state(state):
    if state is None:
        say('password state unread')
        return
    has = 'true' if state.get('has_password') else 'false'
    say(f'password has_password={has}')


def cmd_state():
    announce_state(read_password_state())


def cmd_set():
    global armed
    state = read_password_state()
    if state is None:
        say('password blocked state-unread')
        return
    if state.get('has_password'):
        say('password blocked already-set')
        return
    password = cloud_password()
    if len(password) < 8:
        say('password blocked missing')
        return
    # Armed before the request so a stop during the round-trip still removes it.
    armed = True
    response = wait_extra(send({
        '@type': 'setPassword',
        'old_password': '',
        'new_password': password,
        'new_hint': PASSWORD_HINT,
        'set_recovery_email_address': False,
        'new_recovery_email_address': '',
    }), 40)
    if response.get('@type') == 'error':
        reason = f'{response.get("code")} {public_error(response.get("message"))}'.strip()
        after = read_password_state()
        if after is not None and after.get('has_password'):
            cleared = clear_password()
            if cleared is not None and not cleared.get('has_password'):
                say(f'password blocked {reason}')
            else:
                say('password has_password=true')
            return
        armed = False
        say(f'password blocked {reason}')
        return
    if response.get('@type') != 'passwordState':
        after = read_password_state()
        if after is not None and not after.get('has_password'):
            armed = False
        say('password blocked unexpected')
        return
    pending_email = response.get('recovery_email_address_code_info') not in (None, '')
    if pending_email or not response.get('has_password'):
        if response.get('has_password'):
            cleared = clear_password()
            if cleared is None or cleared.get('has_password'):
                say('password has_password=true')
                return
        else:
            armed = False
        reason = 'recovery-email' if pending_email else 'not-enabled'
        say(f'password blocked {reason}')
        return
    armed = True
    say('password set')


def cmd_clear():
    state = clear_password()
    announce_state(state)


def cmd_mark():
    refresh_baseline()
    say('marked')


def cmd_code():
    try:
        code = wait_for_code(60)
    except TimeoutError:
        say('code missing')
        return
    secret['code'] = code
    publish()
    say('code ready')


def cmd_drop_web():
    response = wait_extra(send({'@type': 'getActiveSessions'}), 30)
    sessions = response.get('sessions') if response.get('@type') == 'sessions' else []
    closed_count = 0
    if isinstance(sessions, list):
        for session in sessions:
            if not isinstance(session, dict):
                continue
            if session.get('is_current') or session.get('device_model') != 'CRM Chat Web':
                continue
            result = wait_extra(send({
                '@type': 'terminateSession',
                'session_id': session.get('id'),
            }), 20)
            if result.get('@type') != 'error':
                closed_count += 1
    say(f'web sessions closed count={closed_count}')


def shutdown():
    global closed
    if closed:
        return
    closed = True
    try:
        if armed:
            state = clear_password()
            announce_state(state)
    except Exception:
        say('password state unread')
    try:
        send({'@type': 'close'})
        deadline = time.time() + 8
        while time.time() < deadline:
            raw = lib.td_receive(0.4)
            if not raw:
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            state = (message.get('authorization_state') or {}).get('@type')
            if state == 'authorizationStateClosed':
                break
    except Exception:
        pass
    wipe_secret()
    shutil.rmtree(tmp, ignore_errors=True)


def on_term(_signum, _frame):
    global stop
    stop = True


signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGINT, on_term)

commands = {
    'state': cmd_state,
    'set': cmd_set,
    'clear': cmd_clear,
    'mark': cmd_mark,
    'code': cmd_code,
    'drop-web': cmd_drop_web,
}

try:
    authorize()
    remember_phone()
    open_service_chat()
    say('ready')
    while not stop:
        command = read_command(5)
        if command is None:
            continue
        if command == 'quit':
            say('quit')
            break
        handler = commands.get(command)
        if handler is None:
            say('error command')
            continue
        try:
            handler()
        except TimeoutError:
            say('error timeout')
        except Exception:
            say(f'error {type(sys.exc_info()[1]).__name__}')
finally:
    shutdown()
