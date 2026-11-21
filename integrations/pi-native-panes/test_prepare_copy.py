import contextlib
import importlib.machinery
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('prepare_copy', str(HERE / 'prepare-copy'))
spec = importlib.util.spec_from_loader('prepare_copy', loader)
prepare_copy = importlib.util.module_from_spec(spec)
loader.exec_module(prepare_copy)


def fake_source(root, version=prepare_copy.PINNED_VERSION):
    source = root / 'source'
    (source / 'pi-extension' / 'subagents').mkdir(parents=True)
    (source / 'pi-extension' / 'subagents' / 'index.ts').write_text('// extension\n')
    (source / 'package.json').write_text(json.dumps({
        'version': version, 'pi': {'extensions': ['./pi-extension/subagents/index.ts']},
    }))
    return source


class PrepareCopyTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        which = mock.patch.object(prepare_copy.shutil, 'which', return_value='/usr/bin/patch')
        which.start()
        self.addCleanup(which.stop)

    def test_other_version_is_refused(self):
        source = fake_source(self.root, '9.9.9')
        dest = self.root / 'dest'
        with self.assertRaisesRegex(ValueError, '--any-version'):
            prepare_copy.prepare(source, dest)
        self.assertFalse(dest.exists())

    def test_any_version_warns_and_goes_on(self):
        source = fake_source(self.root, '9.9.9')
        dest = self.root / 'dest'
        err = io.StringIO()
        # The fake package has no LICENSE etc., so the copy stops later; the warning comes first.
        with contextlib.redirect_stderr(err), self.assertRaises(OSError):
            prepare_copy.prepare(source, dest, any_version=True)
        self.assertIn('warning', err.getvalue())
        self.assertIn('9.9.9', err.getvalue())
        self.assertFalse(dest.exists(), 'a failed prepare removes its own directory')

    def test_destination_inside_source_is_refused(self):
        source = fake_source(self.root)
        with self.assertRaisesRegex(ValueError, 'non-nested'):
            prepare_copy.prepare(source, source / 'inside')
        with self.assertRaisesRegex(ValueError, 'non-nested'):
            prepare_copy.prepare(source, self.root)

    def test_symlinked_resources_are_refused(self):
        source = fake_source(self.root)
        (source / 'LICENSE').symlink_to(self.root / 'elsewhere')
        dest = self.root / 'dest'
        with self.assertRaisesRegex(ValueError, 'symlinked'):
            prepare_copy.prepare(source, dest)
        self.assertFalse(dest.exists())

    def test_existing_destination_is_refused_and_kept(self):
        source = fake_source(self.root)
        dest = self.root / 'dest'
        dest.mkdir()
        (dest / 'mine.txt').write_text('keep')
        with self.assertRaises(FileExistsError):
            prepare_copy.prepare(source, dest)
        self.assertEqual((dest / 'mine.txt').read_text(), 'keep')

    def test_update_needs_the_marker(self):
        dest = self.root / 'plain'
        dest.mkdir()
        with self.assertRaisesRegex(ValueError, 'not a prepared copy'):
            prepare_copy.update(dest)
        self.assertEqual(list(dest.iterdir()), [])

    def test_update_refreshes_launcher_files_only(self):
        dest = self.root / 'copy'
        (dest / 'pi-extension' / 'subagents').mkdir(parents=True)
        (dest / '.herdr-native-copy').write_text('marker\n')
        (dest / 'pi-extension' / 'subagents' / 'index.ts').write_text('patched extension')
        (dest / 'pi-extension' / 'subagents' / 'native.ts').write_text('old')
        (dest / 'orchestrator').write_text('old')
        with contextlib.redirect_stdout(io.StringIO()):
            prepare_copy.update(dest)
        self.assertEqual((dest / 'pi-extension' / 'subagents' / 'native.ts').read_text(), (HERE / 'native.ts').read_text())
        self.assertEqual((dest / 'orchestrator').read_text(), (HERE / 'orchestrator').read_text())
        self.assertEqual((dest / 'herdr-tmux').read_text(), (HERE.parent / 'pi-tmux' / 'herdr-tmux').read_text())
        for name in ['pi-native', 'VARIANTS.md', 'herdr-status.ts']:
            self.assertTrue((dest / name).is_file(), name)
        self.assertEqual((dest / 'pi-extension' / 'subagents' / 'index.ts').read_text(), 'patched extension')


if __name__ == '__main__':
    unittest.main()
