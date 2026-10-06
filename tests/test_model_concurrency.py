import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('model_concurrency', pathlib.Path(__file__).parents[1] / 'server/model_concurrency.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class ModelConcurrencyTests(unittest.TestCase):
    def test_metrics_sum_unique_engines_and_keep_endpoint_scope(self):
        text = '''# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="Gemma",engine="0"} 2
vllm:num_requests_running{engine="1",model_name="Gemma"} 3.0
vllm:num_requests_waiting{model_name="Gemma",engine="0"} 0
vllm:num_requests_waiting{model_name="Gemma",engine="1"} 4
secret_prompt_text{prompt="must never propagate"} 100
'''
        result=m.parse_metrics(text)
        self.assertEqual(result['running'],5);self.assertEqual(result['waiting'],4);self.assertEqual(result['modelName'],'Gemma')
        self.assertNotIn('prompt',json.dumps(result))

    def test_unlabeled_total_not_added_to_labeled_series(self):
        result=m.parse_metrics('vllm:num_requests_running 5\nvllm:num_requests_running{engine="0"} 2\nvllm:num_requests_running{engine="1"} 3')
        self.assertEqual(result['running'],5)

    def test_model_totals_overlapping_engine_series_and_mixed_runtimes_are_unknown(self):
        overlapping='vllm:num_requests_running{model_name="M"} 5\nvllm:num_requests_running{model_name="M",engine="0"} 2\nvllm:num_requests_running{model_name="M",engine="1"} 3'
        self.assertIsNone(m.parse_metrics(overlapping)['running'])
        for text in ('vllm:num_requests_running 2\nllamacpp:requests_deferred 1', 'vllm:num_requests_running 2\nllamacpp:requests_processing 3'):
            metrics=m.parse_metrics(text)
            self.assertIsNone(metrics['running']);self.assertIsNone(metrics['waiting']);self.assertEqual(metrics['metricNames'],[])

    def test_secret_shaped_model_labels_never_escape(self):
        for label in ('sk-0123456789abcdef','password=fixture','Bearer fixture'):
            result=m.parse_metrics('vllm:num_requests_running{model_name='+json.dumps(label)+'} 2')
            self.assertIsNone(result['modelName']);self.assertNotIn(label,json.dumps(result))

    def test_duplicate_invalid_counter_and_missing_metrics_are_unknown(self):
        values=['vllm:num_requests_running{engine="0"} 2\nvllm:num_requests_running{engine="0"} 2',
                'vllm:num_requests_running NaN','vllm:num_requests_running -1','vllm:num_requests_running 1.5',
                '# TYPE vllm:num_requests_running counter\nvllm:num_requests_running 8',
                'unrelated_metric 0','vllm:num_requests_running{engine="0",engine="1"} 2']
        for value in values:
            with self.subTest(value=value): self.assertIsNone(m.parse_metrics(value)['running'])
        self.assertEqual(m.parse_metrics('llamacpp:requests_processing 0')['running'],0)

    def test_multi_model_metrics_dont_claim_a_single_model_and_labels_escape(self):
        result=m.parse_metrics('vllm:num_requests_running{model_name="Gemma"} 2\nvllm:num_requests_running{model_name="Qwen"} 1')
        self.assertEqual(result['running'],3);self.assertIsNone(result['modelName'])
        self.assertEqual(m.labels(r'model_name="a\\b",engine="0"')['model_name'],'a\\b')

    def test_potentially_waking_slots_never_requested_even_when_props_says_awake(self):
        for sleeping in (True, False, None):
            calls=[]
            def get(base,route,as_json=False):
                calls.append(route)
                if route=='/metrics':raise m.TelemetryUnavailable(501)
                if route=='/props':return {'total_slots':24,'is_sleeping':sleeping}
                self.fail('Unexpected potentially waking request')
            with patch.object(m, 'KNOWN_LLAMA', frozenset({'http://192.0.2.20:31989'})):
                row=m.service({'base':'http://192.0.2.20:31989','runtime':'API'},'fixture','now',get)
            self.assertEqual(calls,['/metrics','/props'])
            self.assertEqual(row['configuredParallelism'],24)
            self.assertIsNone(row['running']);self.assertIsNone(row['waiting'])

    def test_llama_metadata_known_parallel_count_and_running_unknown_waiting(self):
        calls=[]
        def get(base,route,as_json=False):
            calls.append((route,as_json))
            if route=='/metrics':raise m.TelemetryUnavailable(501)
            if route=='/props':return {'total_slots':2,'system_prompt':'PRIVATE'}
            self.fail('Only non-waking metadata routes are permitted')
        with patch.object(m, 'KNOWN_LLAMA', frozenset({'http://192.0.2.20:31989'})):
            result=m.service({'base':'http://192.0.2.20:31989','runtime':'OpenAI uyumlu'},'fixture','now',get)
        self.assertEqual(result['configuredParallelism'],2);self.assertIsNone(result['running']);self.assertIsNone(result['waiting'])
        self.assertEqual(result['scope'],'service');self.assertEqual(result['status'],'partial');self.assertEqual(result['capacity']['status'],'not_tested')
        self.assertEqual(calls,[('/metrics',False),('/props',True)])
        self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('SECRET',json.dumps(result))

    def test_unsupported_ollama_never_assumes_default_or_loaded_model_as_requests(self):
        def get(*args):raise m.TelemetryUnavailable(404)
        result=m.service({'base':'http://127.0.0.1:11434','runtime':'Ollama'},'fixture','now',get,lambda:{})
        self.assertEqual(result['status'],'unsupported');self.assertIsNone(result['running']);self.assertIsNone(result['configuredParallelism'])
        configured=m.service({'base':'http://127.0.0.1:11434','runtime':'Ollama'},'fixture','now',get,lambda:{'OLLAMA_NUM_PARALLEL':2,'OLLAMA_MAX_QUEUE':64})
        self.assertEqual(configured['configuredParallelismScope'],'per-model');self.assertEqual(configured['configuredQueueLimit'],64)

    def test_only_fixed_readonly_metadata_routes_are_allowed(self):
        for route in ('/api/generate','/v1/chat/completions','/slots','/slots/1?action=save'):
            with self.assertRaises(ValueError):m.fetch('http://192.0.2.20:31989',route)
        with self.assertRaises(ValueError):m.fetch('http://other-host:31989','/slots')

    def test_unavailable_and_reachable_but_unsupported_are_distinct(self):
        def refused(*args):raise m.TelemetryUnavailable()
        item={'base':'http://example:8000','runtime':'API'}
        self.assertEqual(m.service(item,'fixture','now',refused)['status'],'unavailable')
        self.assertEqual(m.service(item,'fixture','now',lambda *args:'unrelated_metric 0')['status'],'unsupported')


if __name__ == '__main__': unittest.main()
