"""Execute source in CPython without producing inspection artifacts."""
import json
import linecache
import sys
import traceback


def _pylab_make_executor():
    compile_source, execute, encode = compile, exec, json.dumps
    original_stdout, original_stderr, original_stdin = sys.stdout, sys.stderr, sys.stdin
    limit = 100_000

    def run(source, filename="main.py"):
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
            result['error'] = ''.join(traceback.format_exception(type(error), error, trace))[:limit]
            if isinstance(error, SyntaxError):
                result['errorKind'] = 'syntax'
                result['errorLine'] = error.lineno or 0
                result['diagnostic'] = f"SYNTAX ERROR\n{error.__class__.__name__}: {error.msg} (line {error.lineno or '?'})"
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


_pylab_execute = _pylab_make_executor()
