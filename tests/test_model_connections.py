import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform != 'linux': raise unittest.SkipTest('Linux read-only discovery tests run on server.')
spec=importlib.util.spec_from_file_location('model_connections',pathlib.Path(__file__).parents[1]/'server/model_connections.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='management-model-tests-')
        self.root=pathlib.Path(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def write(self,name,text):
        path=self.root/name;path.write_text(text);return str(path)

    def test_sanitization_never_returns_credentials_query_or_fragment(self):
        self.assertEqual(m.safe_url('https://user:password@host:443/v1?api_key=secret#token'),'https://host:443/v1')
        self.assertEqual(m.safe_url('http://[::1]:8000/v1'),'http://[::1]:8000/v1')
        self.assertIsNone(m.safe_url('file:///etc/shadow'))
        self.assertIsNone(m.safe_url('http://host:bad/v1'))
        self.assertIsNone(m.safe_url('http://host/\nsecret'))
        self.assertNotIn('abcdef',m.safe_url('https://host/token/abcdef/v1'))
        self.assertIsNone(m.safe_model('sk-secret_key_never_publish'))

    def test_ast_does_not_execute_project_and_resolves_env_default(self):
        path=self.write('config.py',"raise RuntimeError('MUST NOT EXECUTE')\nimport os\nLLM_URL = os.getenv('LLM_URL', 'http://default/v1').rstrip('/')\nLLM_MODEL: str = os.getenv('LLM_MODEL', 'gemma')\nAPI_KEY='not-for-output'\n")
        result=m.fields(path,{'LLM_URL':'http://runtime/v1/'})
        self.assertEqual(result['LLM_URL'][0],'http://runtime/v1')
        self.assertEqual(result['LLM_URL'][1]['kind'],'process')
        self.assertEqual(result['LLM_MODEL'][0],'gemma')
        self.assertNotIn('API_KEY',result)

    def test_function_config_runtime_url_and_return_dict_model(self):
        path=self.write('llm.py',"import os\ndef _cfg():\n    base = os.environ.get('LLM_BASE_URL', 'http://127.0.0.1:8000/v1').rstrip('/')\n    return {'model': os.environ.get('LLM_MODEL','qwen3.8-27b'), 'other': 'unused'}\ndef unrelated():\n    model='wrong'\n")
        profile={'bindings':[{'file':path,'function':'_cfg','url':'base','model':'model'}]}
        rows,partial=m.connections(profile,{'LLM_BASE_URL':'http://127.0.0.1:18000/v1'}, {})
        self.assertFalse(partial);self.assertEqual(rows[0]['endpoint'],'http://127.0.0.1:18000/v1')
        self.assertEqual(rows[0]['model'],'qwen3.8-27b')
        self.assertEqual(rows[0]['scope'],'process')
        self.assertEqual({e['kind'] for e in rows[0]['evidence']},{'process','source'})

    def test_local_function_assignment_does_not_override_global_config(self):
        path=self.write('scope.py',"MODEL='global-model'\nURL='http://global'\ndef helper():\n    MODEL='local-model'\n    URL='http://wrong'\n")
        data=m.fields(path,{})
        self.assertEqual(data['MODEL'][0],'global-model')
        self.assertEqual(data['URL'][0],'http://global')

    def test_dotenv_priority_and_runtime_model_fallback(self):
        path=self.write('.env',"GEMMA_URL=http://configured/v1?token=never-output\nGEMMA_MODEL='gemma'\nAPI_KEY=never-output\n")
        rows,_=m.connections({'bindings':[{'environment':True,'file':path,'url':'GEMMA_URL','model':'GEMMA_MODEL'}]}, {'GEMMA_URL':'http://runtime/v1'}, {})
        self.assertEqual(rows[0]['endpoint'],'http://runtime/v1');self.assertEqual(rows[0]['model'],'gemma')
        self.assertNotIn('never-output',json.dumps(rows))
        data=m.fields(path,{'GEMMA_MODEL':'qwen'})
        self.assertEqual(data['GEMMA_MODEL'][0],'qwen')

    def test_symlinks_special_files_and_missing_sources_are_not_followed(self):
        source=self.write('config.py',"URL='http://safe/v1'\nMODEL='gemma'\n")
        link=self.root/'alias.py';link.symlink_to(source)
        fifo=self.root/'pipe.py';os.mkfifo(fifo)
        for path in [link,fifo,self.root/'missing.py']:
            rows,partial=m.connections({'bindings':[{'file':str(path),'url':'URL','model':'MODEL'}]}, {}, {})
            self.assertEqual(rows,[]);self.assertTrue(partial)

    def test_longest_root_isolation_and_explicit_env_keys(self):
        source=self.write('nested.py',"import os\ndef cfg():\n    base=os.getenv('LLM_BASE_URL','http://default')\n    return {'model':'qwen'}\n")
        config=self.write('targets.json',json.dumps([
            {'roots':['/home/project'],'bindings':[]},
            {'roots':['/home/project/sub'],'bindings':[{'file':source,'function':'cfg','url':'base','model':'model','environmentKeys':['LLM_BASE_URL']}]},
        ]))
        apps=[{'pid':1,'port':8080,'directory':'/home/project/sub/app'},{'pid':2,'port':8081,'directory':'/home/project-other'}]
        seen=[]
        def environment(app,keys):seen.extend(keys);return {'LLM_BASE_URL':'http://runtime'}
        with patch.object(m,'process_environment',side_effect=environment):m.discover(apps,config)
        self.assertIn('LLM_BASE_URL',seen)
        self.assertEqual(apps[0]['modelConnections'][0]['endpoint'],'http://runtime')
        self.assertNotIn('modelConnections',apps[1])


if __name__=='__main__':unittest.main()
