import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('model_concurrency', pathlib.Path(__file__).parents[1] / 'server/model_concurrency.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

NIM = '''# TYPE num_request_max gauge
num_request_max{model_name="google/gemma-4-31b-it"} 1024.0
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="google/gemma-4-31b-it"} 3.0
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine="0",model_name="google/gemma-4-31b-it"} 2.0
'''


class NimConcurrencyTests(unittest.TestCase):
    def test_verified_nim_route_combines_vllm_counters_and_reported_ceiling(self):
        calls = []
        def get(base, route):
            calls.append((base, route))
            return NIM
        with patch.object(m, 'KNOWN_NIM', frozenset({'http://192.0.2.20:30456'})):
            row = m.service({'base': 'http://192.0.2.20:30456', 'runtime': 'OpenAI uyumlu'}, 'fixture', 'now', get)
        self.assertEqual(calls, [('http://192.0.2.20:30456', '/v1/metrics')])
        self.assertEqual((row['running'], row['waiting'], row['configuredParallelism']), (3, 2, 1024))
        self.assertEqual(row['runtime'], 'NVIDIA NIM')
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['capacity']['status'], 'not_tested')
        self.assertEqual(row['modelName'], 'google/gemma-4-31b-it')
        self.assertEqual({s['kind'] for s in row['sources']}, {'metrics', 'configuration'})
        self.assertTrue(all(s['source'].endswith('/v1/metrics') for s in row['sources']))

    def test_zero_is_valid_observed_load_but_not_a_capacity(self):
        result = m.parse_metrics(NIM.replace('3.0', '0.0').replace('2.0', '0.0'), nim=True)
        self.assertEqual((result['running'], result['waiting']), (0, 0))
        for invalid in ('0', '-1', 'NaN', '1.5'):
            self.assertIsNone(m.parse_metrics(NIM.replace('1024.0', invalid), nim=True)['configuredParallelism'])

    def test_ceiling_requires_explicit_gauge_and_unambiguous_scope(self):
        for sample in (NIM.replace('num_request_max gauge', 'num_request_max counter'),
                       NIM.replace('# TYPE num_request_max gauge', ''),
                       NIM + 'num_request_max{model_name="other"} 512\n',
                       NIM.replace('num_request_max{model_name=', 'num_request_max{engine="0",model_name='),
                       NIM.replace('num_request_max{model_name="google/gemma-4-31b-it"}', 'num_request_max{model_name="other"}')):
            self.assertIsNone(m.parse_metrics(sample, nim=True)['configuredParallelism'])

    def test_generic_runtime_does_not_infer_nim_from_a_common_metric_name(self):
        self.assertIsNone(m.parse_metrics(NIM)['configuredParallelism'])
        with self.assertRaises(ValueError):
            m.fetch('http://another-host:8000', '/v1/metrics')

    def test_mixed_runtime_or_duplicate_wrapper_counters_not_double_counted(self):
        mixed = m.parse_metrics(NIM + 'llamacpp:requests_processing 3\n', nim=True)
        self.assertIsNone(mixed['running'])
        self.assertIsNone(mixed['configuredParallelism'])
        duplicate = m.parse_metrics(NIM + 'num_requests_running{model_name="google/gemma-4-31b-it"} 3\n', nim=True)
        self.assertIsNone(duplicate['running'])

    def test_unrelated_labels_never_escape(self):
        result = m.parse_metrics(NIM + 'private_gauge{prompt="private question",token="secret"} 1\n', nim=True)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('secret', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
