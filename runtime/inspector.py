"""Optional CPython compiler inspection. Only JSON crosses the engine boundary."""
import ast
import dis
import io
import json
import linecache
import sys
import token
import tokenize
import traceback
import types


def _pylab_make_inspector():
    # Capture helpers so user globals cannot accidentally overwrite the runner.
    compile_source, encode = compile, json.dumps
    disassemble, instructions, code_type = dis.dis, dis.get_instructions, types.CodeType
    original_stdout, original_stderr = sys.stdout, sys.stderr
    original_stdin = sys.stdin
    limits = {}
    limit = 0

    def utf16_prefix(value, budget):
        used = 0
        for index, character in enumerate(value):
            width = 2 if ord(character) > 0xffff else 1
            if used + width > budget:
                return value[:index], used
            used += width
        return value, used

    class LimitedText(io.StringIO):
        def __init__(self):
            super().__init__()
            self.units = 0

        def write(self, value):
            remaining = limit - self.units
            if remaining > 0:
                piece, units = utf16_prefix(value, remaining)
                super().write(piece)
                self.units += units
            return len(value)

    def inspect_tokens(source):
        items = []
        warning = ""
        truncated = False
        try:
            for item in tokenize.generate_tokens(io.StringIO(source).readline):
                if len(items) >= limits['tokenCount']:
                    truncated = True
                    break
                items.append({
                    "type": token.tok_name.get(item.type, "UNKNOWN"),
                    "value": item.string[:limits['tokenValueChars']],
                    "line": item.start[0],
                    "column": item.start[1] + 1,
                    "endLine": item.end[0],
                    "endColumn": item.end[1] + 1,
                })
        except (tokenize.TokenError, IndentationError) as error:
            warning = utf16_prefix(f"SYNTAX ERROR — tokenization stopped: {error}", limit)[0]
        return items, warning, truncated

    def inspect_ast(root):
        text = LimitedText()
        remaining = limits['astNodeCount']
        nodes = []

        def label(node):
            name = type(node).__name__
            for key in ("name", "id", "attr", "value"):
                if key in ("value",) and not isinstance(node, ast.Constant):
                    continue
                if hasattr(node, key):
                    value = getattr(node, key)
                    if isinstance(value, (str, int, float, complex, bool, type(None))):
                        return f"{name} ({key}={repr(value)[:100]})"
            return name

        def detail_fields(node):
            fields = []
            for key, value in ast.iter_fields(node):
                if len(fields) >= limits['astFieldCount']:
                    break
                if key == "ctx" or (value is None and key != "value"):
                    continue
                if isinstance(value, ast.operator | ast.unaryop | ast.boolop | ast.cmpop):
                    fields.append({"name": "operator", "value": type(value).__name__})
                elif key == "ops" and isinstance(value, list) and all(isinstance(op, ast.cmpop) for op in value):
                    fields.append({"name": "operators", "value": ", ".join(type(op).__name__ for op in value[:8])})
                elif isinstance(value, (str, int, float, complex, bool)) or value is None:
                    fields.append({"name": key, "value": repr(value)[:120]})
            return fields

        def visit(node, prefix="", last=True, root=True):
            nonlocal remaining
            if remaining <= 0:
                return
            remaining -= 1
            node_id = f"ast-{len(nodes)}"
            if node_parents:
                nodes[int(node_parents[-1][4:])]["children"].append(node_id)
            nodes.append({
                "id": node_id, "parentId": node_parents[-1] if node_parents else None,
                "depth": len(node_parents), "type": type(node).__name__, "label": label(node),
                "fields": detail_fields(node), "children": [],
                "lineno": getattr(node, "lineno", None),
                "col_offset": getattr(node, "col_offset", None),
                "end_lineno": getattr(node, "end_lineno", None),
                "end_col_offset": getattr(node, "end_col_offset", None),
            })
            node_parents.append(node_id)
            text.write(("" if root else prefix + ("└── " if last else "├── ")) + label(node) + "\n")
            children = list(ast.iter_child_nodes(node))
            child_prefix = prefix + ("    " if last else "│   ") if not root else ""
            for index, child in enumerate(children):
                if remaining <= 0:
                    text.write(child_prefix + "└── [Further AST nodes omitted]\n")
                    break
                visit(child, child_prefix, index == len(children) - 1, False)
            node_parents.pop()

        node_parents = []
        visit(root)
        return text.getvalue(), nodes

    def inspect_locations(root):
        """Serializable CPython positions, including explicit missing locations."""
        objects, mapped = [], []
        truncated = False

        def visit(code, parent_id=None, depth=0):
            nonlocal truncated
            if len(objects) >= limits['codeObjectCount'] or depth > limits['codeDepth']:
                truncated = True
                return
            code_id = f"co-{len(objects)}"
            def constant_text(value):
                return f"<code object {value.co_name[:limits['metadataNameChars']]}>" if isinstance(value, code_type) else repr(value)[:limits['metadataConstantChars']]
            objects.append({"id": code_id, "parentId": parent_id,
                            "name": code.co_name[:limits['metadataNameChars']], "firstLine": code.co_firstlineno,
                            "depth": depth, "argcount": code.co_argcount,
                            "nlocals": code.co_nlocals, "stacksize": code.co_stacksize,
                            "flags": code.co_flags, "bytecodeLength": len(code.co_code),
                            "constants": [constant_text(value) for value in code.co_consts[:limits['codeMetadataCount']]],
                            "names": [name[:limits['metadataNameChars']] for name in code.co_names[:limits['codeMetadataCount']]],
                            "varnames": [name[:limits['metadataNameChars']] for name in code.co_varnames[:limits['codeMetadataCount']]],
                            "metadataTruncated": any(len(values) > limits['codeMetadataCount'] for values in
                                                     (code.co_consts, code.co_names, code.co_varnames))})
            for instruction in instructions(code, show_caches=False, adaptive=False):
                if len(mapped) >= limits['instructionCount']:
                    truncated = True
                    break
                position = instruction.positions
                source = None
                if position is not None and position.lineno is not None:
                    source = {"line": position.lineno, "column": position.col_offset,
                              "endLine": position.end_lineno, "endColumn": position.end_col_offset}
                mapped.append({"id": f"{code_id}:{instruction.offset}",
                               "codeId": code_id, "offset": instruction.offset,
                               "opcode": instruction.opname, "arg": instruction.arg,
                               "argrepr": instruction.argrepr[:limits['instructionArgChars']], "source": source})
            for value in code.co_consts:
                if isinstance(value, code_type):
                    visit(value, code_id, depth + 1)

        visit(root)
        return {"codeObjects": objects, "instructions": mapped,
                "instructionsTruncated": truncated}

    def describe(root):
        text = LimitedText()
        remaining_objects = limits['codeObjectCount']

        def visit(code, depth=0):
            nonlocal remaining_objects
            if remaining_objects <= 0 or depth > limits['codeDepth']:
                text.write("\n[Further nested code objects omitted]\n")
                return
            remaining_objects -= 1
            prefix = "  " * depth
            text.write(f"{prefix}CPYTHON CODE OBJECT: {code.co_name} (line {code.co_firstlineno})\n")
            fields = (
                ("co_name", code.co_name),
                ("co_filename", code.co_filename),
                ("co_argcount", code.co_argcount),
                ("co_posonlyargcount", code.co_posonlyargcount),
                ("co_kwonlyargcount", code.co_kwonlyargcount),
                ("co_nlocals", code.co_nlocals),
                ("co_stacksize", code.co_stacksize),
                ("co_flags", f"0x{code.co_flags:04x}"),
                ("co_names", code.co_names),
                ("co_varnames", code.co_varnames),
                ("co_freevars", code.co_freevars),
                ("co_cellvars", code.co_cellvars),
                ("bytecode length", f"{len(code.co_code)} bytes"),
            )
            for name, value in fields:
                text.write(f"{prefix}{name}: {value!s}\n")
            text.write(f"{prefix}co_consts:\n")
            for index, value in enumerate(code.co_consts):
                rendered = f"<code object {value.co_name}>" if isinstance(value, code_type) else repr(value)
                text.write(f"{prefix}  [{index}] {rendered[:2000]}\n")
            text.write("\n")
            for value in code.co_consts:
                if isinstance(value, code_type):
                    visit(value, depth + 1)
        visit(root)
        return text.getvalue()

    def inspect_bytecode(root):
        text = LimitedText()
        remaining_objects = limits['codeObjectCount']

        def visit(code, depth=0):
            nonlocal remaining_objects
            if remaining_objects <= 0 or depth > limits['codeDepth']:
                text.write("[Further nested code objects omitted]\n")
                return
            remaining_objects -= 1
            text.write(f"CODE OBJECT: {code.co_name} (line {code.co_firstlineno})\n")
            text.write(f"Constants: {len(code.co_consts)}  Names: {len(code.co_names)}\n\n")
            text.write(f"{'Offset':<9}{'Opcode':<28}Argument\n")
            for instruction in instructions(code, show_caches=False, adaptive=False):
                argument = "" if instruction.arg is None else str(instruction.arg)
                if instruction.argrepr:
                    argument += f" ({instruction.argrepr[:300]})"
                text.write(f"{instruction.offset:<9}{instruction.opname:<28}{argument}\n")
            raw = code.co_code
            text.write(f"\nBytecode bytes ({len(raw)} bytes, hexadecimal):\n")
            for offset in range(0, min(len(raw), 16000), 16):
                text.write(f"  {offset:04x}  {raw[offset:offset+16].hex(' ')}\n")
            if len(raw) > 16000:
                text.write("  [Further bytes omitted]\n")
            text.write("\n")
            for value in code.co_consts:
                if isinstance(value, code_type):
                    visit(value, depth + 1)

        visit(root)
        return text.getvalue()

    def operate(source, filename, limits_json):
        nonlocal limit
        limits.clear()
        limits.update(json.loads(limits_json))
        limit = limits['analysisFieldChars']
        result = {
            "tokens": [], "tokenError": "", "tokensTruncated": False,
            "astTree": "", "astDump": "", "astError": "", "compileError": "",
            "codeObject": "", "bytecode": "", "disassembly": "",
            "error": "", "errorLine": 0,
            "trace": {"astNodes": [], "codeObjects": [], "instructions": [],
                      "instructionsTruncated": False},
        }
        # Restore standard streams and built-in module registrations between runs.
        sys.stdout, sys.stderr, sys.stdin = original_stdout, original_stderr, original_stdin
        previous_source = linecache.cache.get(filename)
        linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
        try:
            result['tokens'], result['tokenError'], result['tokensTruncated'] = inspect_tokens(source)
            try:
                tree = ast.parse(source, filename=filename, mode='exec', type_comments=True)
            except SyntaxError as error:
                result['astError'] = utf16_prefix(f"SYNTAX ERROR\n{error.__class__.__name__}: {error.msg} (line {error.lineno or '?'})", limit)[0]
                result['compileError'] = utf16_prefix(result['astError'] + "\nNo code object or bytecode was produced.", limit)[0]
                raise
            result['astTree'], result['trace']['astNodes'] = inspect_ast(tree)
            result['astDump'] = utf16_prefix(ast.dump(tree, indent=2), limit)[0]
            code = compile_source(source, filename, 'exec', dont_inherit=True, optimize=0)
            result['trace'].update(inspect_locations(code))
            result['codeObject'] = describe(code)
            result['bytecode'] = inspect_bytecode(code)
            listing = LimitedText()
            disassemble(code, file=listing, depth=limits['codeDepth'], show_caches=False, adaptive=False)
            result['disassembly'] = listing.getvalue()
        except BaseException as error:
            if isinstance(error, SyntaxError) and not result['compileError']:
                result['compileError'] = utf16_prefix(f"SYNTAX ERROR\n{error.__class__.__name__}: {error.msg} (line {error.lineno or '?'})\nNo code object or bytecode was produced.", limit)[0]
            # The wrapper's exec frame is an implementation detail, not user code.
            trace = error.__traceback__
            if trace is not None:
                trace = trace.tb_next
            parts, remaining = [], limit
            for part in traceback.TracebackException(type(error), error, trace, limit=20).format():
                if remaining <= 0:
                    break
                piece, units = utf16_prefix(part, remaining)
                parts.append(piece)
                remaining -= units
            result['error'] = ''.join(parts)
            if isinstance(error, SyntaxError):
                result['errorLine'] = error.lineno or 0
            else:
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

    return operate


_pylab_inspect = _pylab_make_inspector()
