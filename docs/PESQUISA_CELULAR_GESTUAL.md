# Pesquisa: celular gestual como instrumento expressivo

**Projeto:** RC Surface (`ableton-rc-surface`)
**Data da pesquisa:** 2026-08-02
**Escopo:** pesquisa técnica e de design; nenhum código foi implementado como parte desta missão.

## Resumo executivo

O RC Surface já tem a base correta para um controlador de celular: cliente no navegador, WebSocket seguro, processamento local de câmera/áudio, mapeamento para MIDI/OSC/Ableton e uma camada de segurança que suaviza sinais, rejeita outliers e reage à perda do telefone. O problema atual não é a ausência de sensores. É que o caminho expressivo está limitado a:

1. dados de movimento crus (`accelerationIncludingGravity` e `rotationRate`);
2. orientação Euler do navegador, com uma correção de inclinação derivada da gravidade;
3. calibração pontual salva no telefone, sem estimativa contínua de viés do giroscópio;
4. snapshots enviados a aproximadamente 30 Hz, mesmo quando o navegador tem uma taxa de tela maior.

Isso coloca uma espera de até aproximadamente 33 ms apenas na quantização do envio, com espera média de aproximadamente 16,7 ms. O próprio projeto registra uma medição local de 30–45 ms entre gesto na tela e resultado no Live, mas essa medição está em documentação do projeto e não foi reproduzida nesta pesquisa. Portanto, trocar WebSocket por UDP pode ajudar a cauda de latência em uma rede ruim, mas não remove o custo dominante do relógio de 30 Hz.

O Gliss é uma referência valiosa por design de instrumento, não porque sua implementação interna seja documentada. Publicamente, ele comprova:

- uma gramática simples de páginas: pads, sliders, botões, postura multitoque, orientação, swipe e “drum hits” do próprio telefone;
- reconhecimento de posturas treinadas pelo usuário, em vez de tentar classificar todos os gestos possíveis;
- limiares de detecção, histerese, modos Trigger/Toggle/Gate e feedback háptico/visual para reduzir disparos acidentais;
- uma camada desktop, o Glover, que mapeia para MIDI ou OSC.

Ele **não** publica o protocolo telefone–Glover, sua latência, o algoritmo de fusão, a política de correção do giroscópio ou o uso direto do magnetômetro. “Set Forward” é uma referência manual de direção; não é evidência de uma correção automática de deriva.

### Recomendação central

O melhor primeiro passo é manter a página web e investir em um modo gestual relativo, seguro e de maior frequência no protocolo atual. Em paralelo, deve-se separar “orientação expressiva” de “atitude absoluta”: a primeira pode funcionar na web com rearmamento, deadzone e filtros; a segunda, estável durante minutos de palco, deve usar fusão de atitude nativa ou uma camada nativa de sensores.

Não é necessário criar um app nativo apenas para obter acelerômetro, giroscópio ou 30–60 Hz. É necessário considerar app nativo quando a meta for atitude fundida confiável, magnetômetro explícito, frequência/jitter além do limite do navegador, haptics de palco consistentes ou funcionamento independente das restrições de uma página web.

## 1. O que o RC Surface já faz

### Arquitetura observada

O fluxo atual é:

```text
telefone / navegador
  ├─ toque, pads, knobs, faders, XY
  ├─ DeviceMotionEvent
  ├─ DeviceOrientationEvent
  ├─ áudio e câmera processados localmente
  └─ snapshot JSON aproximadamente a cada 33 ms
        ↓ WSS /ws
servidor Node
  ├─ SafeInput / SafeSignalFilter
  ├─ mappings
  ├─ MIDI UDP para 127.0.0.1:9000
  ├─ OSC UDP
  └─ Ableton Live / AbletonOSC
```

Fontes locais verificadas: `static/phone-v3/app.js`, `src/server/ws.ts`, `src/live/mappings.ts`, `src/live/safe-input.ts`, `static/phone-v3/sensor-orientation.test.mjs`, `tests/safe-input-layer.test.mjs`, `docs/PRIVACY.md` e `docs/SECURITY.md`.

### Sensores e tratamento atual

| Entrada | O que o navegador fornece | O que o RC Surface faz hoje | Limite expressivo |
|---|---|---|---|
| Acelerômetro | `accelerationIncludingGravity`, em `ax/ay/az` | Envia o valor normalizado; no servidor há clamp e mapeamento | Contém gravidade; não separa aceleração linear de inclinação de forma geral |
| Giroscópio | `rotationRate.alpha/beta/gamma`, em `gx/gy/gz` | Envia velocidade angular; não integra para atitude | Velocidade angular sozinha deriva quando integrada |
| Orientação | `alpha/beta/gamma` do `deviceorientation` | Usa Euler do navegador; recalcula beta/gamma a partir da gravidade quando há movimento; corrige a rotação da tela | Não é uma fusão explícita controlada pelo projeto; não há quaternion nem estimador de viés |
| Magnetômetro | Não é lido diretamente pelo cliente | Nenhuma chamada direta ou campo próprio | Não há garantia de rumo absoluto; uma orientação do navegador pode ser fundida pelo sistema, mas isso não é identificável pelo código atual |
| Tela multitoque | Pontos e gestos de UI | Pads, sliders, knobs, XY, gestos de toque | A tela continua sendo a entrada mais determinística para eventos discretos |
| Câmera/áudio | Processamento no telefone | Opcional; o dado bruto não é enviado | O cliente tem custo de CPU e ciclo de vida; não é um canal de controle contínuo comparado aqui |

O cliente pede permissão em uma ação explícita do usuário quando as APIs de movimento exigem isso. A chamada atual para `DeviceOrientationEvent.requestPermission()` não passa explicitamente `true`; portanto, o RC Surface não está solicitando de forma explícita a orientação absoluta/magnetométrica definida pela API quando essa opção existe. Isso não prova que o telefone não faça alguma fusão interna, apenas que a aplicação não controla nem verifica essa dimensão.

O cliente define `TICK_MS = 33` e envia snapshots a cerca de 30 Hz. Há um loop de `requestAnimationFrame` para atualizar controles locais na taxa da tela, mas isso não aumenta a taxa do snapshot de sensores no fio. Os testes locais confirmam que sensores são colocados no estado e enviados no snapshot, não em mensagens imediatas separadas.

### Segurança já existente

O RC Surface já resolve parte importante do problema de palco:

- `SafeSignalFilter` suaviza sinais de sensor, aplica deadzone e rejeita um salto isolado grande;
- entradas contínuas usam deadzone, histerese e modos de pickup/scale/jump;
- perda de sensor/cliente passa por uma política de hold e depois release, em vez de simplesmente apagar o mapeamento;
- entradas momentâneas liberam imediatamente em cancelamento/desconexão;
- triggers discretos têm limiar e histerese;
- calibração de orientação usa offsets armazenados no `localStorage`.

Essas proteções reduzem ruído e acidentes. Elas **não** substituem uma fusão de atitude: um filtro de outlier pode rejeitar um salto, mas não sabe que um pequeno erro de giroscópio acumulou cinco graus durante vários minutos.

## 2. O que o Gliss ensina — e o que não é possível afirmar

Fontes principais: [página oficial do Gliss](https://mimugloves.com/gliss/), [documentação do Gliss](https://mimugloves.com/documentation/gliss/), [documentação de mapeamento do Glover](https://production.mimugloves.com/documentation/mapping/), [introdução ao Glover](https://production.mimugloves.com/documentation/intro-to-glover/) e [listagem da App Store](https://apps.apple.com/gb/app/gliss/id1457585439).

### Sensores e combinação

A listagem oficial descreve explicitamente acelerômetro e giroscópio, traduzidos em pitch, yaw e roll. A documentação também diz que a orientação é enviada sempre, independentemente da página ativa, e expõe Pitch, Yaw e Roll; “Forward” é a direção definida ao abrir o app e pode ser redefinida.

Não encontrei documentação oficial do Gliss dizendo que ele lê o magnetômetro, nem dizendo se usa Madgwick, Mahony, filtro complementar, Core Motion ou um filtro proprietário. A hipótese plausível é que o app nativo use alguma atitude processada pelo iOS, mas isso não foi verificado e não deve virar requisito assumido. O máximo que a evidência pública permite afirmar é:

> Gliss usa movimento inercial e publica uma orientação expressiva em pitch/yaw/roll; o modo exato de combinar os sensores e corrigir deriva permanece não documentado.

Essa diferença é importante: o RC Surface hoje publica os sensores e uma orientação de navegador; o Gliss publica uma semântica de instrumento. O segundo não necessariamente tem uma solução pública melhor para a física, mas esconde a física atrás de controles musicais mais úteis.

### Gestos oferecidos e reconhecimento

| Mecanismo no Gliss | Reconhecimento / uso documentado | Aplicação possível ao RC Surface |
|---|---|---|
| Pads | Nove pads; deslizar entre eles cria strum/legato | Eventos discretos com trajetória contínua, sem precisar classificar movimento livre |
| Sliders | Seis controles contínuos | Separar “parâmetro estável” de “gesto transitório” |
| Buttons | Quatro botões; também há uso com Pop Socket e modo tela para baixo | Funções de arm, cena, mute ou reset que não dependem de inclinação |
| Posturas | O usuário treina uma postura tocando a tela por dois segundos; o algoritmo diferencia quantidade e posição dos dedos; até 20 posturas | Reconhecimento supervisionado pequeno e explícito, em vez de uma biblioteca aberta de gestos ambíguos |
| Swipe X/Y | Pode ser combinado com uma postura mantida | Acrescentar um eixo expressivo apenas enquanto um estado seguro está armado |
| Orientação | Pitch, yaw e roll estão disponíveis em todas as páginas | Tratar orientação como qualificador de uma ação, não como comando sempre ativo |
| “Drum hits” | Cinco ações descritas: lados do telefone, flicks para esquerda/direita e movimento brusco para baixo com tela para cima | Eventos de alta energia devem ter limiar e contexto, não responder a qualquer mudança pequena |

Há uma pequena inconsistência editorial na documentação oficial: dois itens aparecem com o rótulo “Flick Left”; o texto e o contexto indicam esquerda/direita, mas o rótulo duplicado não foi independentemente resolvido.

O ponto de design mais forte é a **combinação hierárquica**: postura ou botão arma um contexto; orientação e swipe modulam dentro desse contexto. Isso reduz a quantidade de movimento que precisa ser reconhecida com certeza absoluta.

### Comunicação com o computador

O Gliss conecta-se por Wi-Fi ao Glover, com telefone e computador na mesma rede. O Glover então mapeia movimentos e eventos para MIDI ou OSC, com IP, porta e endereço OSC configuráveis.

Não encontrei uma especificação pública do caminho **Gliss → Glover**. Não é possível verificar se ele usa OSC, MIDI, UDP, TCP, WebSocket ou um protocolo privado, nem seu tamanho de pacote, frequência, jitter ou latência. O fato de o Glover emitir MIDI/OSC para o software musical não significa que o app use esses mesmos protocolos na entrada.

Também não encontrei uma medição de latência publicada pelo MiMu. Logo, qualquer afirmação como “Gliss tem X ms” seria inventada.

### Deriva do giroscópio

Não encontrei no material público do Gliss uma descrição de:

- estimativa de bias do giroscópio;
- correção contínua por gravidade ou campo magnético;
- filtro Madgwick, Mahony, complementar ou Kalman;
- procedimento de calibração de magnetômetro;
- teste de deriva ao longo de minutos.

O comando “Set Forward” e a redefinição de direção são uma referência manual útil. Eles evitam que o músico precise aceitar o rumo absoluto inicial do telefone, mas não demonstram que o rumo permanece correto sem nova referência. Portanto, a resposta honesta para “como o Gliss resolve deriva?” é: **a documentação pública não permite saber se ele a resolve automaticamente; o que está comprovado é um re-zero/referência manual e uma boa camada de interação por cima da orientação**.

### Como evitam disparos acidentais

A documentação do Glover descreve mecanismos diretamente relevantes para palco:

- cada movimento pode ter limiar de início e de liberação;
- eventos têm “detection threshold”, permitindo mover o dispositivo sem disparar um drum até que a força seja suficiente;
- há modos Trigger, Toggle, Gate e Send;
- entradas podem ser contínuas ou enviar apenas quando mudam;
- há reset ao liberar e curvas de warp;
- combinações logicamente conflitantes são desabilitadas automaticamente;
- cenas têm mensagens de inicialização e saída;
- o Gliss fornece feedback visual e vibração do telefone;
- posturas treinadas e botões funcionam como estados explícitos, reduzindo a área em que um movimento pode significar um comando.

### Divergências com o RC Surface

| Gliss | RC Surface hoje | Trade-off |
|---|---|---|
| App nativo e uma orientação musical escondendo a física | Página web expõe `motion.*` e `orient.*` e usa orientação do navegador | Web instala instantaneamente e é multiplataforma; app nativo dá acesso mais controlado a Core Motion e feedback |
| Orientação enviada continuamente, independente da página | Sensores via snapshot de 30 Hz | Gliss pode manter uma atitude mais fluida; RC Surface conserva um protocolo simples, mas perde resolução temporal |
| Posturas treinadas, até 20 | Nenhum banco equivalente de posturas multitoque | Treino pequeno é previsível, porém adiciona estado, UI e persistência |
| Threshold de evento, modos Trigger/Toggle/Gate e conflitos | Há threshold/histerese e SafeInput, mas não a mesma gramática de eventos/contextos | RC Surface já tem a base de segurança; falta uma camada de intenção musical |
| Feedback háptico e visual de dispositivo | Há dashboard/Stage e feedback visual; não foi verificado um caminho háptico equivalente no cliente web | Feedback sem olhar reduz erro; haptics no iOS web não tem a mesma disponibilidade de app nativo |
| Glover separa dispositivo, mapeamento e destino MIDI/OSC | Servidor já faz mapeamento e saída MIDI/OSC | A separação conceitual já existe; o vocabulário de gestos e cenas é a lacuna |
| Protocolo interno e filtro não publicados | Transporte e filtros são auditáveis no repositório | RC Surface pode ser medido e depurado; não deve copiar uma implementação que o Gliss não documenta |

## 3. Fusão de sensores na prática

### O problema físico

O giroscópio mede velocidade angular. Integrar essa velocidade fornece atitude, mas qualquer bias pequeno se acumula. O acelerômetro fornece gravidade quando o telefone não está sofrendo aceleração linear importante; por isso corrige bem inclinação, mas não distingue inclinação de uma aceleração do braço. O magnetômetro fornece uma referência de rumo, porém sofre com hard iron, soft iron, caixas, cabos, alto-falantes e estruturas metálicas do palco.

Assim, “acelerômetro + giroscópio + magnetômetro” não é uma soma ingênua de três valores. É um estimador de estado, normalmente representado como quaternion ou matriz, que decide quanto confiar em cada medida ao longo do tempo.

### Comparação dos filtros

| Filtro | Como combina | Deriva / benefício | Falha prática | Adequação ao RC Surface |
|---|---|---|---|---|
| Complementar | Giroscópio passa mudanças rápidas; gravidade e, opcionalmente, magnetômetro corrigem baixa frequência | Muito barato, baixa latência e fácil de entender; limita deriva quando há referência válida | Um único ganho fixo não sabe distinguir gravidade de aceleração; rumo magnético pode saltar | Bom primeiro filtro para pitch/roll relativos; não basta sozinho para rumo de palco |
| Mahony | Observador não linear em SO(3), com erro de referência e termo integral para estimar bias | Pode estimar bias do giroscópio online; baixo custo e funciona com accel+gyro ou MARG | Depende de referências confiáveis; aceleração linear e interferência magnética contaminam o erro | Boa opção explícita se houver estado de atitude e calibração controlados pelo servidor/native layer |
| Madgwick | Quaternion com descida de gradiente; versão MARG usa campo magnético e compensa distorção/bias | Um parâmetro principal, custo baixo e boa resposta em taxas mais baixas; popular em IMUs | O parâmetro é trade-off entre ruído e responsividade; não faz milagre com magnetômetro ruim ou movimento altamente acelerado | Boa opção de referência para protótipo mensurável, desde que o dado seja amostrado e timestamped com qualidade |
| EKF/UKF | Modelo probabilístico completo de estado, ruído e bias | Pode representar incerteza e modos complexos | Mais parâmetros, tuning e risco de parecer preciso sem ser; custo de validação maior | Não é o primeiro investimento justificável para o produto atual |

O [relatório original de Madgwick](https://x-io.co.uk/downloads/madgwick_internal_report.pdf) descreve a representação por quaternion, compensação de distorção magnética e compensação de drift do giroscópio. O [artigo de Mahony](https://doi.org/10.1109/TAC.2008.923738) descreve observadores complementares não lineares e estimação online de bias. Um [benchmark de atitude em smartphones](https://tyrex.inria.fr/mobile/benchmarks-attitude/) compara algoritmos em condições concretas; ele é uma boa lembrança de que “melhor filtro” depende da taxa, do movimento e do ruído do telefone.

### Decisão recomendada para este projeto

1. **Não integrar `rotationRate` cru diretamente como solução de longo prazo.** Isso produz um controle imediato, mas garante deriva.
2. Para gestos relativos, manter uma referência de início/rearmamento e usar velocidade angular filtrada com deadzone, decaimento e limite de excursão. O controle deve representar “girei desde o armamento”, não “o telefone está no rumo absoluto do mundo”.
3. Para pitch/roll, usar gravidade com rejeição de períodos de aceleração linear, combinada com giro para resposta rápida. Um complementar bem medido provavelmente entrega mais valor inicial que uma arquitetura probabilística completa.
4. Quando a necessidade for yaw absoluto ou atitude consistente após vários minutos, usar quaternion e Madgwick/Mahony em uma camada que tenha timestamps, calibração de bias e acesso confiável à atitude. O filtro deve produzir `attitude`/`relative_attitude` sem quebrar os campos `sensor.*` existentes.
5. Tratar magnetômetro como referência de baixa confiança, não como verdade: recalibrar, detectar anomalias e permitir desligá-lo em palco.

## 4. Transporte, taxa e latência

### Números que são relevantes

| Medição ou limite | Número | Qualificação |
|---|---:|---|
| Intervalo do snapshot atual | 33 ms | `TICK_MS = 33`, aproximadamente 30 Hz, verificado no cliente |
| Espera de amostragem causada por 30 Hz | 0–33 ms; média ideal de 16,7 ms | Quantização antes de WebSocket, não é latência de rede |
| x-OSC em estudo NIME | RTT médio 5,30 ms, 95% abaixo de 6,59 ms em condição ideal | Hardware OSC dedicado, não telefone; estudo usou Wi-Fi e host ligado por Ethernet |
| x-OSC sob carga | RTT médio 8,09 ms, 95% abaixo de 9,96 ms | Mostra o efeito da carga, não um valor universal para qualquer Wi-Fi |
| Pipo, sensor até PC | Média de aproximadamente 5 ms após remover 1,4 ms de USB-serial | Outra plataforma de sensor; não é medição de smartphone |
| Taxa típica citada em revisão de IMUs artísticas | 100–400 Hz para gesto contínuo; 50–200 Hz em controle musical | Requisito/estado da arte reportado, não garantia de navegador |
| Alvo de latência citado na mesma revisão | abaixo de 10 ms | Meta para sistemas de performance, não o resultado do RC Surface |

Fontes: [estudo NIME sobre Wi-Fi e música ao vivo](https://opensoundcontrol.stanford.edu/publications/2014-Making-the-Most-of-Wifi-Optimisations-for-Robust-Wireless-Live-Music-Performance.html), [PDF do estudo](https://cnmat.berkeley.edu/sites/default/files/attachments/2014_Making_The_Most_Wifi_Optimisations.pdf), [medição do Pipo](https://www.crowdsupply.com/pipo-interfaces/pipo/updates/all-about-open-sound-control) e [revisão de IMUs sem fio em artes performáticas](https://pmc.ncbi.nlm.nih.gov/articles/PMC12526951/).

O estudo NIME é especialmente útil porque não apresenta “Wi-Fi” como uma propriedade única: usa pacotes pequenos, unicast, um ponto de acesso dedicado e um computador ligado por Ethernet. O desempenho obtido não pode ser transplantado diretamente para um telefone e WebSocket, mas mostra que a rede local pode ficar na ordem de poucos milissegundos quando a topologia é controlada.

### WebSocket/TCP versus UDP/OSC

O WebSocket do RC Surface roda sobre TCP: entrega ordenada e confiável, conexão já estabelecida e integração simples com o navegador. Para pequenos pacotes em uma rede limpa, o custo de serializar JSON e atravessar a fila do aplicativo pode ser mais importante que o cabeçalho do transporte.

UDP/OSC oferece uma semântica melhor para “último estado vence”: um pacote perdido pode ser descartado e o próximo valor absoluto corrige o estado. O preço é que a aplicação precisa adicionar sequência, timestamp, detecção de perda e política de recuperação. UDP não torna automaticamente o sensor mais rápido; em uma rede sem perda, o ganho médio pode ser pequeno, enquanto em perda/congestionamento ele pode evitar que valores antigos fiquem presos atrás de retransmissões TCP.

Para o RC Surface, a ordem de impacto provável é:

1. aumentar ou desacoplar a taxa de aquisição/envio dos sensores;
2. enviar estado absoluto com timestamp e “latest wins”;
3. medir P50/P95/P99 e perda no equipamento alvo;
4. só então comparar WSS com UDP/OSC em uma rede degradada.

Uma mudança para UDP é uma **mudança de arquitetura**, pois exige entrada no servidor, autenticação/pairing, compatibilidade de mapeamentos, perda segura e tratamento de reconexão. Não é um patch isolado de transporte.

### Tamanho de pacote e buffers

Os snapshots atuais carregam controles, toques, movimento, orientação, sensores e estado de rede; câmera e áudio brutos não são enviados. Pacotes pequenos e sem compressão são apropriados para controle. JSON facilita diagnóstico, mas um pacote binário ou um schema compacto pode reduzir CPU e bytes se a taxa subir.

O maior risco de buffer é entregar um valor velho depois que o músico já produziu outro gesto. Para controles contínuos, o receptor deve preferir o valor mais recente e não acumular uma fila infinita. Para eventos, deve preservar ordem, identificador e estado de release. Essa diferença entre contínuo e evento é mais importante que uma promessa genérica de “baixa latência”.

### 5 GHz versus 2,4 GHz

Não encontrei uma medição controlada, específica para telefone como controlador musical, que permita declarar “5 GHz acrescenta ou remove X ms”. A evidência disponível sustenta apenas a regra operacional:

- 2,4 GHz tem maior alcance e atravessa melhor obstáculos, mas é mais sujeito a redes vizinhas e congestionamento; o próprio relato do RC Surface observa picos em 2,4 GHz lotado;
- 5 GHz costuma oferecer canais menos congestionados e mais largura de banda, mas perde alcance mais rapidamente e sofre mais com paredes e distância;
- ponto de acesso dedicado, host ligado por Ethernet, canal fixo e rede sem tráfego concorrente melhoram a previsibilidade mais do que trocar a banda sem medir.

A recomendação é medir no local do show: timestamp de captura, timestamp de envio, chegada ao servidor, saída MIDI/OSC, jitter e P50/P95/P99. Um ping médio não mede a espera do snapshot nem a fila do Live.

## 5. Ferramentas que já resolveram partes do problema

Estas ferramentas são referências de técnica e design, não recomendações de compra.

| Ferramenta | O que resolve bem | O que não resolve para o RC Surface |
|---|---|---|
| [TouchOSC](https://hexler.net/touchosc/manual/complete) | Editor modular, MIDI e OSC simultâneos, scripting, widgets, acelerômetro, giroscópio e feedback por vibração; pode usar USB-MIDI em dispositivos compatíveis | É uma caixa de ferramentas de controle, não uma solução documentada de fusão de atitude ou reconhecimento de postura musical |
| [Lemur](https://www.midikinetics.com/lemur/) | Editor e scripting profundos, oito portas MIDI/OSC, widgets customizáveis, variável de acelerômetro e clock interno de 60 ticks/s (16 ms) | A documentação pública consultada expõe acelerômetro e relógio, mas não apresenta uma solução pronta para deriva ou um vocabulário gestual como o Gliss |
| [GyrOSC](https://apps.apple.com/ca/app/gyrosc/id418751595) | Ponte direta de sensores para OSC: pitch/roll/yaw, aceleração, bússola, quaternion, matriz de rotação, gravidade, campo magnético e GPS | Maximiza acesso a sinais, mas deixa a semântica musical, filtros e segurança para o receptor |
| [Mrmr](https://apps.apple.com/us/app/mrmr-osc-controller/id294296343) | Controle OSC configurável no dispositivo, editor integrado, botões, sliders, toque, acelerômetro e descoberta Bonjour em versões históricas | Projeto antigo; manutenção e compatibilidade atual não foram auditadas além do histórico da App Store. Não há evidência pública de fusão moderna ou segurança de palco |
| [RJDJ / instrumentos de iPhone descritos no NIME 2010](https://www.nime.org/proceedings/2010/nime2010_088.pdf) | Mostra uso de uma mão, combinação de tela e acelerômetro e camadas de mapeamento básico/expressivo | É uma referência de design e não uma implementação pronta para o protocolo atual |

A diferença entre essas ferramentas e o Gliss é útil: TouchOSC, Lemur, GyrOSC e Mrmr expõem componentes/protocolos para o usuário construir o instrumento; Gliss pré-constrói um vocabulário de gestos e uma política de segurança. O RC Surface já está entre os dois: tem a infraestrutura de transporte/mapeamento e precisa escolher quanto de “instrumento pronto” quer adicionar.

## 6. O que a literatura NIME sugere

NIME tem mais de duas décadas de experimentos com interfaces gestuais, celulares e instrumentos digitais. Os achados úteis aqui não são “use sensor X”, mas critérios de instrumento.

### O que tende a funcionar

- **Mapeamento legível e aprendível.** O trabalho [Making Mappings: Design Criteria for Live Performance](https://nime.pubpub.org/pub/f1ueovwv/release/1) trata legibilidade, controle e agência como propriedades do mapeamento, não como consequência automática de usar um sensor. Um gesto deve ter um resultado musical percebível e repetível.
- **Separação entre gesto binário e expressão contínua.** O estudo do [Smartphone Ensemble](https://www.nime.org/proceedings/2016/nime2016_paper0013.pdf), com 21 não especialistas e seis participantes do ensemble, reporta que a tela foi melhor avaliada para controle não ambíguo, enquanto tilt e microfone foram percebidos como expressivos. Isso favorece tela/botão para armar ou disparar e IMU para timbre, dinâmica ou modulação.
- **Contexto de uma mão.** O trabalho de 2010 sobre iPhone/RJDJ e [Passively Augmenting Mobile Devices](https://www.nime.org/proceedings/2017/nime2017_paper0004.pdf) mostram que segurar o telefone e tocar a tela compete pelos dedos. Handles, postura definida e poucos controles simultâneos tornam o gesto mais praticável.
- **Processamento perto do sensor.** O trabalho [The Phone with the Flow](https://www.nime.org/proceedings/2018/nime2018_paper0032.pdf) processa câmera no telefone, envia features por OSC e usa câmera/touch como uma combinação expressiva. Isso confirma a direção atual do RC Surface de não transmitir áudio/vídeo bruto.
- **Feedback sem depender de olhar.** A revisão de smartphones em NIME [Tanaka Survey](https://www.nime.org/proceedings/2012/nime2012_240.pdf) registra portabilidade, sensores e gestos como vantagens, mas também latência, problemas de GUI e ausência de haptic feedback como limitações recorrentes. O feedback do Gliss — vibração e sinal visual — responde exatamente a esse problema.

### O que cansa ou falha

Não há, nas fontes consultadas, uma medição única e geral de fadiga para o telefone como controlador. O que a literatura permite dizer com segurança é:

- manter o telefone suspenso, afastado do corpo ou em uma postura fixa por muitos minutos pode criar esforço de punho/antebraço; a ergonomia deve ser avaliada em sessões longas, não apenas em uma demonstração;
- gestos grandes e contínuos têm custo físico maior que eventos curtos, e a falta de resistência tátil torna fácil fazer movimentos exagerados para obter uma resposta;
- interfaces sem haptic feedback exigem mais confirmação visual e podem competir com a atenção musical;
- estudos de interfaces gestuais em NIME reportam fadiga física quando a ergonomia obriga o performer a manter o braço ou o dispositivo em uma posição ruim; isso é evidência de um risco de design, não uma medida específica do RC Surface.

Como referência, [Mixed Reality Musical Interface](https://nime.pubpub.org/pub/g1ja2o6o/release/1) encontrou, com dez músicos, temas recorrentes de esforço físico e tamanho/campo de visão, embora seja uma interface de realidade mista e não um telefone. [Physical interface design for digital musical instruments](https://escholarship.mcgill.ca/concern/theses/h128ng18h) explica o problema mais amplo: instrumentos digitais frequentemente não oferecem o acoplamento físico e feedback háptico de instrumentos acústicos.

Implicações para o RC Surface:

1. não mapear cada grau de liberdade para um parâmetro importante;
2. usar orientação principalmente como modulação, enquanto tela/botão seleciona o alvo;
3. limitar o tamanho e a duração de gestos de evento;
4. permitir neutral, rearmamento e “hold” sem exigir que o telefone permaneça em uma pose desconfortável;
5. avaliar cinco, quinze e trinta minutos de uso contínuo com o músico, medindo erro, tensão percebida e necessidade de olhar para a tela.

## 7. Limites do navegador e fronteira do app nativo

### O que a web consegue

Em uma página HTTPS/WSS e com gesto explícito do usuário, o navegador pode fornecer aceleração, rotação e orientação. `DeviceMotionEvent.interval` informa o intervalo de aquisição associado ao evento; a API não promete uma taxa musical universal. `deviceorientation` também é disparado quando há dados novos, mas a taxa efetiva depende de navegador, sistema, sensor, visibilidade e economia de energia.

Fontes: [MDN DeviceMotionEvent](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent), [MDN Device Orientation Events](https://developer.mozilla.org/en-US/docs/Web/API/Device_orientation_events) e [MDN requestPermission da orientação](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static).

No iOS, o WebKit historicamente limitou os eventos de orientação a 20 Hz e depois os elevou para 60 Hz; o [WebKit Bug 145814](https://bugs.webkit.org/show_bug.cgi?id=145814) registra essa mudança e observa que o frame rate do iOS é intencionalmente limitado a 60 Hz, apesar de o giroscópio poder operar acima disso. Isso é evidência de um limite de implementação, não uma promessa para todos os modelos atuais. A taxa real deve ser medida com `event.interval` e timestamps no telefone.

`requestAnimationFrame` também não é um sensor: ele acompanha a tela e pode rodar a 60, 90 ou 120 Hz, mas não cria amostras novas de movimento. No RC Surface, além disso, os dados só entram no snapshot de 30 Hz.

Para orientação absoluta, a API permite pedir uma permissão com o parâmetro `absolute` em navegadores que o suportam. Isso exige ação transitória do usuário e contexto seguro. Mesmo concedida, a disponibilidade e a qualidade da referência magnética variam; a página deve detectar ausência, não assumir.

### O que o app nativo acrescenta

O [CMMotionManager da Apple](https://developer.apple.com/documentation/CoreMotion/CMMotionManager) oferece acesso a acelerômetro, giroscópio, magnetômetro e `deviceMotion` processado, incluindo atitude, aceleração do usuário, gravidade e velocidade de rotação. Um app nativo pode escolher o intervalo de atualização, observar timestamps reais e usar a fusão de atitude do Core Motion. O intervalo também é limitado pelo hardware e pelo sistema; app nativo não elimina ruído nem garante uma rede perfeita.

Um app nativo é justificável quando houver necessidade de:

- atitude fundida pelo Core Motion ou filtro próprio com magnetômetro explícito;
- taxa/jitter acima do que o browser entrega com consistência;
- haptic feedback confiável e sincronizado;
- controle do ciclo de vida, inclusive comportamento fora de uma página visível;
- processamento de gesture recognition e áudio/câmera com prioridade de sistema.

Um app nativo **não é pré-requisito** para pads, sliders, toque, acelerômetro, giroscópio, câmera local ou uma experiência de 30–60 Hz em palco. Se a página web continuar enviando só 30 Hz, um app nativo que capture 100 Hz apenas criará dados que serão descartados depois.

### Decisão de roadmap

| Categoria | Pode permanecer na arquitetura web | Exige mudança de arquitetura | Exige app nativo ou camada nativa |
|---|---|---|---|
| Pads, botões, sliders, XY e telas de Stage | Sim | — | — |
| Deadzone, histerese, threshold, hold/release, latest state | Sim, com o protocolo atual | Melhorar política de evento e telemetria | — |
| Gestos relativos de tilt/roll, rearmados | Sim, se aceitarmos referência relativa e taxa atual | Recomendável separar evento de contínuo | — |
| Sensor contínuo a 60 Hz no servidor | O navegador pode produzir, dependendo do aparelho | Sim: desacoplar aquisição do snapshot de 30 Hz | Não necessariamente |
| Quaternion/fusão Madgwick ou Mahony no backend | Sim, se houver dados suficientes e timestamped | Sim: novo estado de atitude, bias e compatibilidade | Não necessariamente |
| Rumo absoluto consistente por minutos | Incerto e dependente de `absolute`/browser/sensor | Sim: modelo de referência e detecção de anomalia | Preferível; Core Motion torna o contrato mais claro |
| Haptics de palco e feedback de sistema | Feedback visual web | Talvez canal de feedback | Preferível no iOS; suporte web é desigual |
| Mais de 60 Hz com jitter controlado | Não é um contrato seguro de browser | Protocolo e pipeline novos | Sim, se for requisito real |
| App em segundo plano / ciclo de vida robusto | Não | — | Sim |

## 8. Plano por fases, sem implementação nesta missão

### (a) Adotar já, com a arquitetura atual

1. **Definir gestos relativos e contextuais.** Um botão, postura simples ou ação de Stage arma o sensor; a orientação modula apenas enquanto o estado estiver armado. Ao liberar, volta a neutral ou hold seguro.
2. **Usar tela para intenção e IMU para expressão.** Pads/botões selecionam ou disparam; pitch/roll/gyro modulam filtro, volume, send, macro ou densidade.
3. **Aplicar threshold + histerese + duração mínima.** Um “drum hit” ou trigger não deve reagir ao primeiro sample; deve exigir energia, direção e/ou janela temporal coerente.
4. **Preservar a camada SafeInput.** Os valores de `sensor.*` continuam compatíveis; o novo comportamento deve passar pela política de perda, release e outlier já existente.
5. **Expor feedback de armamento.** Stage precisa mostrar claramente neutral, armed, active e lost; o músico deve saber o que está autorizado antes de mover o telefone.
6. **Medir antes de trocar transporte.** Registrar timestamps do telefone, do WebSocket, do servidor e da saída MIDI/OSC. Sem isso, “UDP é mais rápido” é apenas uma hipótese.

### (b) O que exige mudança de arquitetura

1. **Separar aquisição de sensores do snapshot de UI.** Manter compatibilidade com snapshots, mas permitir um canal/estrutura de sensor a 60 Hz ou mais quando disponível. O servidor deve usar o último estado válido, não uma fila de valores antigos.
2. **Adicionar timestamp, sequência e qualidade.** Cada amostra deve informar idade, perda e validade; eventos precisam de ordem e release, controles contínuos precisam de latest-wins.
3. **Introduzir um contrato de atitude.** Além de `sensor.orient.alpha/beta/gamma`, criar conceitualmente `relative_attitude`/quaternion, referência atual, qualidade magnética e estado de calibração. A saída antiga deve continuar para não quebrar mappings.
4. **Colocar a fusão em um único lugar.** O cliente pode pré-processar, mas a escolha deve ser explícita: navegador/cliente, servidor ou camada nativa. Misturar Euler corrigido no telefone com filtro diferente no servidor dificulta medir deriva.
5. **Criar máquina de estados de palco.** `idle → armed → active → released/lost`, com threshold, tempo mínimo, cancelamento, feedback e recuperação. O modelo do Glover é uma boa referência; a camada SafeInput atual é a fundação, não a máquina completa.
6. **Só depois avaliar UDP/OSC.** Se os percentis mostrarem cauda por perda/retransmissão, adicionar transporte de estado contínuo com sequência e perda segura. Não trocar eventos confiáveis e contínuos indistintamente.

### (c) O que exige app nativo

1. **Atitude e magnetômetro com contrato explícito no iPhone.** Usar Core Motion ou equivalente para obter atitude, gravidade, aceleração do usuário e rumo, com calibração e timestamps do sistema.
2. **Taxa acima do browser com jitter controlado.** A necessidade deve ser demonstrada por medição; para muitos controles de Ableton, 60–100 Hz pode ser suficiente, mas o browser não deve prometer isso em todas as condições.
3. **Haptics de palco consistentes.** O Gliss usa vibração como confirmação. Se a ausência de feedback visual for um requisito, app nativo é o caminho confiável.
4. **Ciclo de vida fora da página.** Se o telefone precisar continuar como controlador quando a tela for bloqueada, a página for suspensa ou o navegador mudar de estado, a web não é um contrato suficiente.

Uma alternativa intermediária seria um app nativo fino apenas para sensores/haptics, mantendo a UI web. Isso reduz a duplicação de interface, mas ainda exige pairing, protocolo local, distribuição, permissões e manutenção de duas plataformas; portanto, é uma mudança de arquitetura, não uma simples substituição do URL.

## 9. Recomendações priorizadas: impacto na expressividade ÷ esforço

Escala qualitativa: **alto impacto / baixo esforço** vem primeiro; “esforço” considera código, testes em aparelhos e risco de palco, não dinheiro.

| Prioridade | Recomendação | Impacto | Esforço | Justificativa |
|---:|---|---|---|---|
| 1 | Modo relativo armado: referência de início, deadzone, histerese e retorno seguro | Alto | Baixo | Ataca deriva percebida e disparo acidental sem mudar o transporte |
| 2 | Separar eventos discretos de modulações contínuas; usar tela/botão para intenção | Alto | Baixo | Converte a evidência do Gliss/NIME em uma gramática compreensível |
| 3 | Feedback de Stage para armed/active/lost e reset explícito | Alto | Baixo | Reduz incerteza de palco e permite tocar sem olhar continuamente |
| 4 | Instrumentação de latência P50/P95/P99 e idade da amostra | Médio-alto | Baixo | Evita otimizar UDP, JSON ou 5 GHz sem saber o gargalo real |
| 5 | Desacoplar sensores do snapshot de 30 Hz, mantendo WSS inicialmente | Alto | Médio | Remove o piso de 33 ms e prepara gestos mais fluidos |
| 6 | Filtro complementar ou Madgwick/Mahony para `relative_attitude` | Alto | Médio | Reduz deriva de pitch/roll e organiza o contrato de atitude; requer validação em movimento |
| 7 | Banco pequeno de posturas treinadas, inspirado no Gliss | Alto | Médio-alto | Cria intenção/contexto poderoso, mas requer UI, persistência e testes de falsos positivos |
| 8 | Transporte UDP/OSC para estado contínuo | Médio | Médio-alto | Pode reduzir cauda em perda, mas não resolve o piso atual e exige segurança/compatibilidade |
| 9 | Camada nativa de Core Motion e haptics | Muito alto | Alto | É o caminho para atitude e feedback controláveis, mas traz distribuição e manutenção de app |
| 10 | Classificador aberto de muitos gestos | Incerto | Alto | Maior risco de ambiguidade, treino e fadiga; não é necessário para validar a gramática básica |

## 10. Pesquisa expandida: implementações e medições públicas

Esta segunda busca muda a conclusão prática. O interior do Gliss continua fechado, mas existem projetos públicos que mostram **como organizar o mesmo problema** e, em alguns casos, fornecem números.

### 10.1 SmartControllerJS: a web não está condenada a 30 Hz

O [SmartControllerJS](https://arxiv.org/abs/2208.02043) é uma biblioteca aberta que transforma um telefone em controlador web por QR code. Usa WebRTC DataChannel entre as páginas, faz throttle configurável e expõe estatísticas de ping e taxa de mensagens.

Nos testes reportados pelos autores:

- ping local em torno de 20 ms RTT;
- 40–80 ms RTT em dispositivos remotos para o joystick e 40–60 ms para touchpad;
- 60–150 mensagens por segundo;
- conexão simples por QR code, sem instalação.

Esses números não são uma medição musical do RC Surface e não substituem um teste no Live. Mas provam duas coisas úteis:

1. uma arquitetura web consegue sustentar muito mais que os 30 snapshots/s atuais em condições favoráveis;
2. medir e exibir a saúde da conexão é parte do controlador, não um luxo de diagnóstico.

O trabalho também encontrou incompatibilidades reais: Safari e algumas versões de Android tiveram problemas com WebRTC, e a rede eduroam bloqueou o transporte. Logo, WebRTC não é uma solução universal nem automaticamente melhor que WSS. A lição adotável é o telemetria/throttle por conexão; o transporte ainda deve ser escolhido pelo ambiente do RC Surface.

### 10.2 `ahrs`: existe uma rota JavaScript concreta para o filtro

A biblioteca JavaScript [ahrs](https://www.npmjs.com/package/ahrs) implementa Madgwick e Mahony, roda no browser e aceita gyro, accel, magnetômetro opcional e `deltaTime`. A própria documentação expõe os parâmetros que precisam ser medidos:

- intervalo de amostragem real;
- `beta` no Madgwick;
- `kp` e `ki` no Mahony;
- inicialização por gravidade e campo magnético;
- conversão correta de eixos e unidades.

Ela também avisa que o magnetômetro é facilmente distorcido por estruturas metálicas, ímãs, correntes e ambientes internos, e que a calibração remove bias mas não conserta um pipeline já filtrado de forma errada.

Isso não significa que o RC Surface deva adicionar uma dependência imediatamente. Significa que a pergunta deixou de ser “será que existe uma implementação?” e passou a ser “qual filtro, com quais eixos, timestamp e dados disponíveis, melhora um replay real do telefone?”. A biblioteca é uma referência concreta para uma prova offline/replay, não uma garantia de desempenho em palco.

### 10.3 Control: taxa de sensor e interface podem ser configuráveis por contexto

O projeto aberto [Control](https://github.com/charlieroberts/Control) é antigo e foi arquivado em maio de 2025, portanto não é uma dependência recomendada. Ainda assim, sua documentação registra uma decisão de arquitetura que o RC Surface pode reaproveitar: acelerômetro, gyro e compass tinham frequência de atualização controlável por interface; interfaces podiam ser enviadas dinamicamente ao telefone via OSC; a aplicação emitia OSC e MIDI sem obrigar uma única UI.

A ideia é importante para o Stage: um modo de pads não precisa consumir a mesma taxa ou os mesmos sensores de um modo de gesto contínuo. O perfil ativo deveria declarar taxa, filtros, deadzone, threshold e feedback, em vez de deixar todos os sensores sempre no mesmo snapshot genérico.

### 10.4 MoMu e NIME 2011: separar sinal, filtro e transporte

O [MoMu: A Mobile Music Toolkit](https://momu.stanford.edu/toolkit/) foi um toolkit aberto de música móvel do CCRMA/Stanford. Ele separava recursos de sensor, callbacks/polling, filtros básicos e rede OSC. O artigo descreve sensores como recursos independentes e oferece filtros como OnePole, PoleZero e biquad para acelerômetro, vídeo e áudio.

Mais diretamente, um instrumento descrito em [NIME 2011](https://www.nime.org/proceedings/2011/nime2011_179.pdf) usou Core Motion para obter movimento processado, transmitiu o yaw rate por OSC sobre UDP e reservou TCP para informações não críticas, como dados de faixa. O artigo não prova que essa divisão seja sempre a melhor, mas fornece um precedente musical explícito para:

- estado contínuo e descartável em canal de baixa latência;
- configuração, nomes, cenas e metadados em canal confiável;
- filtro próximo da captura, antes de atravessar a rede.

Isso é mais acionável que uma troca genérica de WebSocket por UDP. Para o RC Surface, o equivalente seria manter WSS para sessão, pairing, mapeamentos e eventos importantes, e criar um canal de estado contínuo somente se a medição mostrar que o snapshot confiável está causando cauda.

### 10.5 Motion Vox: a combinação touch + movimento é um padrão recorrente

O [Motion Vox](https://motionvox.app/) é uma aplicação de música móvel que descreve explicitamente uma combinação de XY touch, acelerômetro e giroscópio com uma “complex data filtering engine”. O gesto de performance mantém um dedo na área ativa enquanto o músico move o aparelho; toque e movimento afetam parâmetros diferentes e podem gerar MIDI em tempo real.

O site não publica o filtro ou uma medição de latência, portanto não resolve a parte física. Ele reforça, porém, uma decisão de design: a expressividade mais controlável não vem de deixar o telefone interpretar qualquer movimento livre; vem de usar toque para declarar o gesto e movimento para modular seu resultado.

### 10.6 Produto atual como evidência de integração, não como benchmark

O [Mobile MIDI](https://pounding.systems/products/mobile-midi) documenta uma arquitetura nativa recente que mapeia touch, movimento, compass, face, mãos e AirPods para MIDI. O fabricante afirma, como valores de transporte, aproximadamente 1–2 ms para USB, 10–20 ms para BLE e 3–8 ms para Network MIDI. Esses números são **declarações do produto**, não uma medição independente comparável ao RC Surface; não há recomendação de compra aqui.

O que vale extrair é a forma de produto: templates prontos, presets, filtro de sensor, MPE, reconexão e três transportes separados. A lacuna do RC Surface não é necessariamente ter mais sensores; é transformar sensores em templates e estados de performance que o músico entende.

### 10.7 App nativo não é sinônimo de baixa latência

O artigo aberto [Cross-Device Motion Interaction via Apple’s Native System Frameworks](https://arxiv.org/abs/2508.01110) usou Core Motion, Core Haptics e MultipeerConnectivity em um iPhone, com pacotes de IMU a 10 Hz em Wi-Fi 5 GHz. O sistema reportou média de 70,4 ms e percentil 95 abaixo de 74 ms, embora tenha observado zero perda de pacote no teste.

Esse resultado é extremamente útil para o roadmap: app nativo, rádio 5 GHz e zero perda não venceram o problema quando a taxa e o pipeline eram inadequados. Portanto:

> primeiro se corrige a taxa, o timestamp, o buffer e a semântica do evento; depois se decide se a captura precisa ser nativa.

### 10.8 O que pode ser melhorado no RC Surface com esta evidência

Agora há uma trilha técnica concreta, ainda sem implementação nesta pesquisa:

1. adicionar medição de RTT, taxa de mensagem, idade e perda por cliente, como SmartControllerJS;
2. testar a cadeia atual com 30, 60 e 100 Hz no mesmo WebSocket antes de trocar o transporte;
3. reproduzir um replay de sensores contra uma implementação Madgwick/Mahony e medir erro de atitude, latência e drift;
4. separar perfil de UI, taxa de sensor, filtro e semântica de evento;
5. manter evento/configuração confiável separado de estado contínuo descartável;
6. usar toque ou armamento como intenção e IMU como modulação, padrão confirmado por Motion Vox, NIME e Gliss;
7. considerar nativo somente quando a medição mostrar que browser + taxa adequada ainda não satisfazem atitude, haptics ou ciclo de vida.

Essa expansão evita ficar dependente de descobrir o código fechado do Gliss. Ela fornece padrões implementáveis, números para comparação e uma ordem de experimentos que pode produzir evidência própria sem comprar nada.

## 11. O que não foi possível verificar

- algoritmo de fusão, uso de magnetômetro e correção automática de deriva no Gliss;
- protocolo interno e latência telefone–Glover do Gliss;
- taxa exata de sensores do iPhone em cada versão de iOS e modelo;
- comparação numérica justa entre WSS e UDP no mesmo telefone, ponto de acesso, pacote e processo do Live;
- diferença em milissegundos entre 5 GHz e 2,4 GHz para o palco do Gabriel;
- fadiga de músicos usando especificamente o RC Surface por sessões longas;
- disponibilidade atual e manutenção completa do Mrmr além dos dados públicos da App Store;
- qualquer benefício real de enviar mais de 60 Hz para os mappings atuais sem medir a capacidade do Live e do computador.

## Referências selecionadas

### Projeto local

- `static/phone-v3/app.js` — captura, calibração, snapshot e permissões.
- `src/server/ws.ts` — WebSocket, rate limit, snapshots e roteamento.
- `src/live/mappings.ts` e `src/live/safe-input.ts` — mapeamento, suavização, outlier e perda segura.
- `docs/PRIVACY.md` e `docs/SECURITY.md` — processamento local e transporte.

### Gliss/Glover

- [Gliss](https://mimugloves.com/gliss/)
- [Documentação do Gliss](https://mimugloves.com/documentation/gliss/)
- [Mapping no Glover](https://production.mimugloves.com/documentation/mapping/)
- [Introdução ao Glover](https://production.mimugloves.com/documentation/intro-to-glover/)
- [Gliss na App Store](https://apps.apple.com/gb/app/gliss/id1457585439)

### Sensores, web e atitude

- [Madgwick — relatório técnico](https://x-io.co.uk/downloads/madgwick_internal_report.pdf)
- [Mahony et al. — Nonlinear Complementary Filters](https://doi.org/10.1109/TAC.2008.923738)
- [Smartphone Attitude Benchmark](https://tyrex.inria.fr/mobile/benchmarks-attitude/)
- [Apple CMMotionManager](https://developer.apple.com/documentation/CoreMotion/CMMotionManager)
- [MDN DeviceMotionEvent](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent)
- [MDN Device Orientation](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static)
- [WebKit Bug 145814](https://bugs.webkit.org/show_bug.cgi?id=145814)

### Rede e performance musical

- [Making the Most of Wi-Fi — NIME/OSC](https://opensoundcontrol.stanford.edu/publications/2014-Making-the-Most-of-Wifi-Optimisations-for-Robust-Wireless-Live-Music-Performance.html)
- [PDF do estudo de Wi-Fi](https://cnmat.berkeley.edu/sites/default/files/attachments/2014_Making_The_Most_Wifi_Optimisations.pdf)
- [Pipo — medição de OSC](https://www.crowdsupply.com/pipo-interfaces/pipo/updates/all-about-open-sound-control)
- [Wireless IMUs in Performing Arts](https://pmc.ncbi.nlm.nih.gov/articles/PMC12526951/)

### Ferramentas e NIME

- [TouchOSC Manual](https://hexler.net/touchosc/manual/complete)
- [Lemur](https://www.midikinetics.com/lemur/)
- [Lemur User Guide](https://support.midikinetics.com/wp-content/uploads/2024/10/Lemur-User-Guide.pdf)
- [GyrOSC](https://apps.apple.com/ca/app/gyrosc/id418751595)
- [Mrmr](https://apps.apple.com/us/app/mrmr-osc-controller/id294296343)
- [Control — repositório arquivado](https://github.com/charlieroberts/Control)
- [SmartControllerJS — artigo e código](https://arxiv.org/abs/2208.02043)
- [`ahrs` para JavaScript](https://www.npmjs.com/package/ahrs)
- [MoMu Mobile Music Toolkit](https://momu.stanford.edu/toolkit/)
- [Motion Vox](https://motionvox.app/)
- [Mobile MIDI — especificações públicas do produto](https://pounding.systems/products/mobile-midi)
- [Cross-Device Motion Interaction — Core Motion/MultipeerConnectivity/Core Haptics](https://arxiv.org/abs/2508.01110)
- [NIME 2010 — iPhone/RJDJ](https://www.nime.org/proceedings/2010/nime2010_088.pdf)
- [NIME 2012 — Tanaka Survey](https://www.nime.org/proceedings/2012/nime2012_240.pdf)
- [NIME 2016 — Smartphone Ensemble](https://www.nime.org/proceedings/2016/nime2016_paper0013.pdf)
- [NIME 2017 — Passively Augmenting Mobile Devices](https://www.nime.org/proceedings/2017/nime2017_paper0004.pdf)
- [NIME 2018 — The Phone with the Flow](https://www.nime.org/proceedings/2018/nime2018_paper0032.pdf)
- [NIME 2011 — instrumento com Core Motion, OSC/UDP e TCP](https://www.nime.org/proceedings/2011/nime2011_179.pdf)
- [Making Mappings](https://nime.pubpub.org/pub/f1ueovwv/release/1)
- [Physical interface design for DMIs](https://escholarship.mcgill.ca/concern/theses/h128ng18h)
