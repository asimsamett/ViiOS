import importlib.util
import io
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('model_concurrency_ollama',pathlib.Path(__file__).parents[1]/'server/model_concurrency.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class OllamaConcurrencyTests(unittest.TestCase):
    def test_exact_loopback_listener_discovery_without_systemctl(self):
        output='LISTEN 0 4096 127.0.0.1:11434 0.0.0.0:* users:(("ollama",pid=999007,fd=3))\n'
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output)) as run:
            self.assertEqual(m.ollama_listener_pid(),999007)
            self.assertEqual(run.call_args.args[0],['/usr/bin/ss','-H','-ltnp','sport = :11434'])

    def test_ambiguous_or_wrong_address_listener_is_unknown(self):
        for output in ('LISTEN 0 4096 192.0.2.20:11434 *:* users:(("ollama",pid=4,fd=3))',
                       'LISTEN 0 4096 127.0.0.1:11435 *:* users:(("ollama",pid=4,fd=3))',
                       'LISTEN 0 4096 127.0.0.1:11434 *:* users:(("ollama",pid=4,fd=3),("other",pid=5,fd=3))'):
            with self.subTest(output=output),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output)):
                self.assertIsNone(m.ollama_listener_pid())

    def identity_open(self,command=b'/usr/bin/ollama\0serve\0'):
        def open_file(path,mode):
            if str(path).endswith('cmdline'):return io.BytesIO(command)
            return io.StringIO('7 (ollama) '+' '.join(['S']+['0']*18+['12345']))
        return open_file

    def test_identity_requires_observed_binary_and_serve_role(self):
        with patch.object(m.os,'readlink',return_value='/usr/bin/ollama'),patch('builtins.open',side_effect=self.identity_open()):
            self.assertEqual(m.ollama_process_identity(7),('/usr/bin/ollama','12345'))
        with patch.object(m.os,'readlink',return_value='/tmp/ollama'),patch('builtins.open',side_effect=self.identity_open()):
            self.assertIsNone(m.ollama_process_identity(7))
        with patch.object(m.os,'readlink',return_value='/usr/bin/ollama'),patch('builtins.open',side_effect=self.identity_open(b'/usr/bin/ollama\0runner\0')):
            self.assertIsNone(m.ollama_process_identity(7))

    def read_settings(self,payload,identities=None):
        with patch.object(m,'ollama_listener_pid',return_value=7),patch.object(m,'ollama_process_identity',side_effect=identities or [('/usr/bin/ollama','123'),('/usr/bin/ollama','123')]),patch('builtins.open',return_value=io.BytesIO(payload)):
            return m.ollama_limits()

    def test_only_explicit_whitelisted_unsigned_settings_are_returned(self):
        result=self.read_settings(b'API_KEY=SECRET\0OLLAMA_NUM_PARALLEL="4"\0OLLAMA_MAX_QUEUE=512\0PROMPT=PRIVATE\0')
        self.assertEqual(result,{'OLLAMA_NUM_PARALLEL':4,'OLLAMA_MAX_QUEUE':512})
        self.assertEqual(self.read_settings(b'API_KEY=SECRET\0'),{})
        self.assertEqual(self.read_settings(b'OLLAMA_NUM_PARALLEL=2.0\0OLLAMA_MAX_QUEUE=1e3\0'),{})
        self.assertEqual(self.read_settings(b'OLLAMA_NUM_PARALLEL=0\0OLLAMA_MAX_QUEUE=0\0'),{'OLLAMA_MAX_QUEUE':0})

    def test_reused_pid_or_oversized_environment_does_not_report_old_values(self):
        self.assertEqual(self.read_settings(b'OLLAMA_NUM_PARALLEL=4\0',[('/usr/bin/ollama','123'),('/usr/bin/ollama','456')]),{})
        self.assertEqual(self.read_settings(b'OLLAMA_NUM_PARALLEL=4\0'+b'x'*(2*1024*1024)),{})


if __name__=='__main__':unittest.main()
