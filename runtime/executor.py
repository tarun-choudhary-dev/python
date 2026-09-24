"""Execute source in CPython without producing inspection artifacts."""
import json
import linecache
import sys
import traceback


def _pylab_make_executor():
    compile_source, execute, encode = compile, exec, json.dumps
    original_stdout, original_stderr, original_stdin = sys.stdout, sys.stderr, sys.stdin
    def run(source, filename, error_limit):
        result = {"error": "", "errorLine": 0, "errorKind": "", "diagnostic": ""}
        sys.stdout, sys.stderr, sys.stdin = original_stdout, original_stderr, original_stdin
        previous_source = linecache.cache.get(filename)
        linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
        try:
            code = compile_source(source, filename, 'exec', dont_inherit=True, optimize=0)
            namespace = {'__name__': '__main__', '__file__': filename, '__builtins__': __builtins__}
            execute(code, namespace, namespace)
        except BaseException as error:
            trace = error.__traceback__
            if trace is not None:
                trace = trace.tb_next
            result['error'] = _bounded_traceback(error, trace, error_limit)
            if isinstance(error, SyntaxError):
                result['errorKind'] = 'syntax'
                result['errorLine'] = error.lineno or 0
                result['diagnostic'] = _utf16_prefix(f"SYNTAX ERROR\n{error.__class__.__name__}: {error.msg} (line {error.lineno or '?'})", error_limit)[0]
            else:
                result['errorKind'] = 'runtime'
                cursor = trace
                while cursor is not None:
                    if cursor.tb_frame.f_code.co_filename == filename:
                        result['errorLine'] = cursor.tb_lineno
                    cursor = cursor.tb_next
        finally:
            if previous_source is None:
                linecache.cache.pop(filename, None)
            else:
                linecache.cache[filename] = previous_source
            sys.stdout, sys.stderr, sys.stdin = original_stdout, original_stderr, original_stdin
            original_stdout.flush()
            original_stderr.flush()
        return encode(result)

    return run


def _utf16_prefix(value, limit):
    used = 0
    for index, character in enumerate(value):
        width = 2 if ord(character) > 0xffff else 1
        if used + width > limit:
            return value[:index], used
        used += width
    return value, used


def _bounded_traceback(error, trace, limit):
    parts, remaining = [], limit
    formatted = traceback.TracebackException(type(error), error, trace, limit=20)
    for part in formatted.format():
        if remaining <= 0:
            break
        piece, units = _utf16_prefix(part, remaining)
        parts.append(piece)
        remaining -= units
    return ''.join(parts)


_pylab_execute = _pylab_make_executor()
