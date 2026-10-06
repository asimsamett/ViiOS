import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('model_catalog', pathlib.Path(__file__).parents[1] / 'server/model_catalog.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class Reader:
    @staticmethod
    def read_text(path, limit=1024*1024):
        data = pathlib.Path(path).read_text()
        if len(data) > limit: raise ValueError('limit')
        return data


class ModelCatalogTests(unittest.TestCase):
    def test_endpoint_allowlist_credentials_paths_and_redirect_routes(self):
        self.assertEqual(m.endpoint_base('http://192.0.2.10:30456/v1/chat/completions', {'192.0.2.10'}), 'http://192.0.2.10:30456')
        for value in ('file:///etc/passwd', 'http://outside/v1', 'http://user:pass@host/v1', 'http://host/v1?key=secret', 'http://host/inference'):
            self.assertIsNone(m.endpoint_base(value, {'host'}))
        with self.assertRaises(ValueError): m.get_json('http://host', '/api/generate')

    def test_api_tags_do_not_imply_loaded_gpu_and_alias_family_uses_metadata(self):
        calls = []
        def fetch(base, route):
            calls.append(route)
            return {'models': [{'name': 'deepseek-v3:latest', 'details': {'family': 'llama', 'parameter_size': '3.2B'}}]} if route == '/api/tags' else {'models': []}
        result = m.endpoint_inventory({'base':'http://127.0.0.1:11434', 'runtime':'Ollama'}, '192.0.2.42', 'now', fetch)
        self.assertTrue(result['ok']); self.assertEqual(result['models'][0]['status'], 'available')
        self.assertFalse(result['models'][0]['loadedFromAPI']); self.assertEqual(result['models'][0]['family'], 'Llama')
        self.assertEqual(calls, ['/api/tags', '/api/ps'])

    def test_only_ps_promotes_loaded_and_absolute_served_model_ids_are_kept(self):
        def fetch(base, route): return {'models':[{'name':'gemma:latest'}]}
        rows = m.endpoint_inventory({'base':'http://localhost:11434', 'runtime':'Ollama'}, 'example-server', 'now', fetch)['models']
        merged = m.merge_models(rows); self.assertEqual(len(merged),1); self.assertEqual(merged[0]['status'],'running')
        self.assertTrue(merged[0]['loadedFromAPI'])
        result = m.endpoint_inventory({'base':'http://host:31989', 'runtime':'OpenAI uyumlu'}, 'example-server', 'now', lambda *args:{'data':[{'id':'/models/Qwen/model.gguf'}]})
        self.assertEqual(result['models'][0]['name'],'/models/Qwen/model.gguf'); self.assertEqual(result['models'][0]['status'],'available')

    def test_endpoint_failures_keep_configured_identity_and_not_false_empty_success(self):
        def unavailable(*args): raise OSError('private exception')
        item={'base':'http://host:8000','runtime':'OpenAI uyumlu','bindings':[{'model':'Gemma','source':'config.py','application':'Test'}]}
        result=m.endpoint_inventory(item,'example-server','now',unavailable)
        self.assertFalse(result['ok']); self.assertEqual(result['models'][0]['status'],'unreachable')
        self.assertNotIn('private',json.dumps(result))

    def test_same_model_at_two_endpoints_keeps_separate_health(self):
        a=m.model_row('Gemma','host','API','available','api','now',endpoint='http://host:1')
        b=m.model_row('Gemma','host','API','unreachable','config','now',endpoint='http://host:2')
        self.assertEqual(len(m.merge_models([a,b])),2); self.assertNotEqual(a['id'],b['id'])

    def test_hf_shards_must_all_exist_and_snapshots_deduplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); folder=root/'models--Qwen--Qwen3-14B-AWQ'/'snapshots'/'first'; folder.mkdir(parents=True)
            (folder/'config.json').write_text(json.dumps({'model_type':'qwen3','quantization_config':{'quant_method':'awq'}}))
            (folder/'model-00001-of-00002.safetensors').write_bytes(b'x')
            rows,_,_=m.file_models(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'configured')
            (folder/'model-00002-of-00002.safetensors').write_bytes(b'x')
            rows,_,_=m.file_models(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'installed');self.assertEqual(rows[0]['quantization'],'AWQ')
            self.assertEqual(rows[0]['name'],'Qwen/Qwen3-14B-AWQ')

    def test_manifest_without_weights_is_not_installed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); manifest=root/'manifests'/'registry.ollama.ai'/'library'/'gemma2'/'latest';manifest.parent.mkdir(parents=True)
            digest='sha256:'+('a'*64); payload={'config':{'digest':digest,'size':2},'layers':[{'digest':digest,'size':2}]};manifest.write_text(json.dumps(payload))
            rows,_,_=m.ollama_disk(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'configured')
            (root/'blobs').mkdir();(root/'blobs'/digest.replace(':','-')).write_text('{}')
            rows,_,_=m.ollama_disk(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'installed')

    def test_gguf_missing_shards_are_not_installed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);(root/'Qwen-00001-of-00002.gguf').write_bytes(b'x')
            rows,_,_=m.file_models(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'configured')
            (root/'Qwen-00002-of-00002.gguf').write_bytes(b'x')
            rows,_,_=m.file_models(str(root),'host','now',Reader());self.assertEqual(rows[0]['status'],'installed')

    def test_legacy_remote_telemetry_cannot_execute_or_expand_selected_server(self):
        config = {'primaryHost': '192.0.2.1', 'primaryName': 'Selected server', 'modelRoots': ['/models'],
                  'remoteTelemetry': [{'host': '192.0.2.2', 'name': 'Other server', 'unit': 'example-tunnel.service',
                                       'sshTarget': 'operator@192.0.2.2', 'modelRoots': ['/private-models']}]}
        helper = SimpleNamespace(read_text=lambda _path: json.dumps(config))
        local_model = m.model_row('Example model', '192.0.2.1', 'Model dosyaları', 'installed', '/models', 'now')
        output = io.StringIO()
        with patch.object(m.sys, 'argv', ['model_catalog.py']), patch.object(m, 'load_connections', return_value=helper), \
             patch.object(m, 'configured_endpoints', return_value=([], [])), \
             patch.object(m, 'gpu_telemetry', return_value=([], None)), \
             patch.object(m, 'file_models', return_value=([local_model], 1, False)) as scan, \
             patch.object(m.subprocess, 'run', side_effect=AssertionError('Unexpected remote process')) as execute, \
             redirect_stdout(output):
            m.main()
        result = json.loads(output.getvalue())
        execute.assert_not_called()
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(scan.call_args.args[:2], ('/models', '192.0.2.1'))
        self.assertEqual([host['host'] for host in result['hosts']], ['192.0.2.1'])
        self.assertEqual(result['models'], [local_model])
        self.assertEqual(result['coverage']['filesChecked'], 1)
        self.assertTrue(any('Sunucular' in warning for warning in result['warnings']))
        self.assertNotIn('192.0.2.2', output.getvalue())


if __name__ == '__main__': unittest.main()
